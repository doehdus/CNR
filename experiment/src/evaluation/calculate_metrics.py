"""깨끗한 기준 음성과 평가 음원을 비교해 실제 STOI·ESTOI를 계산한다.

처리 순서: 음원 목록 확인 → WAV 읽기 → 리샘플링·시간 정렬 → 지표 계산 → 결과 저장.
기존 3문장 평가 목록은 보존하며 --prefilter-bpf로 새 12문장·144조건의
원본/BPF 대응 비교를 별도 회차에 계산한다(CONTRIBUTING.md).
실제 지표 연산은 pystoi가 담당하며, 이 코드는 입력 준비·검증·결과 기록을 담당한다.

공개 함수: prepare_signals, calculate_signals, calculate_wav_pair, calculate_dataset,
write_results. 모듈을 불러오는 것만으로는 파일을 저장하지 않으며, 선택한 음원이
모두 계산에 성공한 뒤 main에서 write_results를 호출해 결과를 저장한다.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import version
from numbers import Integral, Real
import sys
import tempfile
from typing import Any
import warnings

import numpy as np
import soundfile as sf
from pystoi import stoi as reference_stoi
from scipy.signal import correlate, correlation_lags, resample_poly

# 실행한 폴더에 관계없이 이 파일의 위치를 기준으로 프로젝트 경로를 찾는다.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST = PROJECT_ROOT / "experiment" / "data" / "metadata" / "dataset.json"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "experiment" / "outputs"
# 실험에서 정한 문장·녹음자·소음·입력 SNR·처리 방식의 허용 조합이다.
# 후속 알고리즘도 목록에 포함되지만, 실제 계산 대상은 실행 옵션으로 선택한다.
STATEMENTS = {"instruction_01": "유채원", "instruction_02": "유채원", "warning_01": "김도연"}
NOISES = ("single", "complex", "changing")
SNRS = (20, 10, 5, 0)
ALGORITHMS = ("noisy", "ss_fixed", "ss_pattern_fixed", "ss_pattern_update", "additional")
# 두 음원을 공통 16 kHz로 맞추고, 기본 ±0.5초 범위에서 하나의 고정 지연을 찾는다.
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_MAX_DELAY_SECONDS = 0.5
# 점수와 함께 계산 구간·정렬 내역·입력 파일 지문을 남겨 나중에 재현할 수 있게 한다.
PREPARATION_FIELDS = (
    "sample_rate", "samples", "reference_sample_rate", "compared_sample_rate",
    "alignment_max_delay_seconds", "alignment_delay_samples", "alignment_correlation",
    "reference_trim_start", "reference_trim_end", "compared_trim_start", "compared_trim_end",
)
CSV_FIELDS = (
    "sample_id", "stoi", "estoi", "tool_version", "reference_id", "reference_path",
    "compared_path", "reference_sha256", "compared_sha256", *PREPARATION_FIELDS, "calculated_at",
)


class MetricInputError(ValueError):
    """잘못된 입력을 오류 코드와 설명으로 전달한다."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class BatchCalculationError(ValueError):
    """일괄 계산에서 실패한 음원 목록을 모아 결과 저장을 중단한다."""

    def __init__(self, errors: list[dict[str, str]]):
        self.errors = errors
        super().__init__(f"{len(errors)}개 음원을 계산하지 못했습니다. 결과 파일은 저장하지 않았습니다.")


def tool_version() -> str:
    """pystoi 버전을 확인하고 계산에 사용한 라이브러리 버전을 기록한다."""
    if version("pystoi") != "0.4.1":
        raise MetricInputError("dependency_version", "이 프로젝트는 pystoi==0.4.1 환경을 사용해야 합니다.")
    return "; ".join(f"{name}/{version(name)}" for name in ("pystoi", "numpy", "scipy", "soundfile")) + "; cnr/2"


def _sample_rate(value: int) -> int:
    """샘플레이트가 양의 정수인지 확인한다. bool도 정수로 취급되므로 제외한다."""
    if isinstance(value, bool) or not isinstance(value, Integral) or value <= 0:
        raise MetricInputError("sample_rate", "샘플레이트는 양의 정수여야 합니다.")
    return int(value)


def _signal(value: Any, label: str) -> np.ndarray:
    """입력을 실수 배열로 바꾸고 단일 채널·길이·수치·신호 변화를 검사한다."""
    try:
        original = np.asarray(value)
        if np.iscomplexobj(original):
            raise ValueError("complex signal")
        signal = np.asarray(original, dtype=np.float64)
    except (ValueError, TypeError, OverflowError) as error:
        raise MetricInputError("invalid_signal", f"{label}: 실수 음성 신호가 필요합니다.") from error
    if signal.ndim != 1:
        raise MetricInputError("channels", f"{label}: mono 1차원 신호만 지원합니다.")
    if not signal.size:
        raise MetricInputError("empty", f"{label}: 음성 신호가 비어 있습니다.")
    if not np.isfinite(signal).all():
        raise MetricInputError("non_finite", f"{label}: NaN 또는 무한대가 있습니다.")
    if not np.any(signal) or np.all(signal == signal[0]):
        raise MetricInputError("silence", f"{label}: 무음 또는 변화가 없는 신호는 평가할 수 없습니다.")
    return signal


def prepare_signals(
    clean: Any,
    compared: Any,
    reference_sample_rate: int,
    compared_sample_rate: int,
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    max_delay_seconds: float = DEFAULT_MAX_DELAY_SECONDS,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """두 단일 채널 음원의 샘플레이트와 시작 시점을 맞추고 공통 구간을 반환한다.

    clean은 깨끗한 원음, compared는 무처리 혼합 음원 또는 처리 결과다.
    지연이 양수이면 비교 음성이 기준 음성보다 늦게 시작한다.
    지연과 앞뒤 제외량은 공통 샘플레이트에서의 샘플 개수로 기록한다.
    지연 탐색에는 평균을 뺀 복사본을 쓰고, 실제 점수에는 리샘플링한 파형을 쓴다.
    """
    sample_rate = _sample_rate(sample_rate)
    reference_sample_rate = _sample_rate(reference_sample_rate)
    compared_sample_rate = _sample_rate(compared_sample_rate)
    if (
        isinstance(max_delay_seconds, bool)
        or not isinstance(max_delay_seconds, Real)
        or not math.isfinite(max_delay_seconds)
        or max_delay_seconds < 0
    ):
        raise MetricInputError("alignment_delay", "시간 정렬의 최대 지연은 0 이상의 유한한 초 단위 값이어야 합니다.")

    # 1. 두 음원을 같은 샘플레이트로 변환한다.
    # 최대공약수로 변환 비율을 줄여 resample_poly의 정수 배율을 구한다.
    resampled = []
    for value, original_rate, label in (
        (clean, reference_sample_rate, "기준 음성"),
        (compared, compared_sample_rate, "비교 음성"),
    ):
        signal = _signal(value, label)
        divisor = math.gcd(original_rate, sample_rate)
        converted = resample_poly(signal, sample_rate // divisor, original_rate // divisor)
        resampled.append(_signal(converted, label))
    reference, target = resampled

    # 2. 교차상관의 절댓값이 최대인 지점에서 파일 전체에 적용할 고정 지연을 찾는다.
    # 탐색 범위 밖의 후보는 제외하며, 이 단계에서는 음원의 진폭을 정규화하지 않는다.
    reference_centered = reference - reference.mean()
    target_centered = target - target.mean()
    correlation = correlate(target_centered, reference_centered, mode="full", method="fft")
    lags = correlation_lags(target.size, reference.size, mode="full")
    max_delay_samples = min(float(max_delay_seconds) * sample_rate, max(reference.size, target.size) - 1)
    candidates = np.flatnonzero(np.abs(lags) <= max_delay_samples)
    peak = candidates[np.argmax(np.abs(correlation[candidates]))]
    delay = int(lags[peak])

    # 3. 먼저 시작한 음원의 앞부분을 제외해 정렬하고, 두 음원이 겹치는 길이만 쓴다.
    reference_start = max(0, -delay)
    target_start = max(0, delay)
    samples = min(reference.size - reference_start, target.size - target_start)
    aligned_reference = _signal(reference[reference_start:reference_start + samples], "정렬된 기준 음성")
    aligned_target = _signal(target[target_start:target_start + samples], "정렬된 비교 음성")
    # 파형의 상관계수는 정렬 상태를 확인하기 위한 별도 기록이며 STOI 점수가 아니다.
    coefficient = float(np.corrcoef(aligned_reference, aligned_target)[0, 1])
    preparation = dict(
        sample_rate=sample_rate,
        samples=int(samples),
        reference_sample_rate=reference_sample_rate,
        compared_sample_rate=compared_sample_rate,
        alignment_max_delay_seconds=float(max_delay_seconds),
        alignment_delay_samples=delay,
        alignment_correlation=coefficient,
        reference_trim_start=reference_start,
        reference_trim_end=int(reference.size - reference_start - samples),
        compared_trim_start=target_start,
        compared_trim_end=int(target.size - target_start - samples),
    )
    return aligned_reference, aligned_target, preparation


def calculate_signals(clean: Any, compared: Any, sample_rate: int) -> dict[str, float]:
    """시간 정렬·길이·샘플레이트가 이미 맞춰진 단일 채널 신호를 평가한다.

    이 함수에서 별도의 정렬·길이 채우기·최대 진폭 정규화·클리핑·채널 평균은 하지 않는다.
    pystoi 내부의 리샘플링·비발화 구간 제거는 라이브러리 규칙대로 적용된다.
    반환하는 두 점수는 명료도 예측 지표이며 실제 단어 정답률이나 백분율이 아니다.
    """
    tool_version()
    sample_rate = _sample_rate(sample_rate)
    reference = _signal(clean, "기준 음성")
    target = _signal(compared, "비교 음성")
    if reference.size != target.size:
        raise MetricInputError("length_mismatch", "기준 음성과 비교 음성 길이가 다릅니다. 시간 정렬을 확인하세요.")
    try:
        with warnings.catch_warnings():
            # pystoi는 유효 프레임이 30개보다 적으면 경고와 함께 대체값 1e-5를 반환한다.
            # 이를 실제 연구 점수로 저장하지 않도록 경고를 예외로 처리한다.
            warnings.simplefilter("error", RuntimeWarning)
            result = {
                # 같은 기준·비교 신호로 일반 STOI와 확장 ESTOI를 각각 계산한다.
                # extended 옵션만 다르며, 반환값에 임의의 배율이나 백분율을 적용하지 않는다.
                "stoi": float(reference_stoi(reference, target, int(sample_rate), extended=False)),
                "estoi": float(reference_stoi(reference, target, int(sample_rate), extended=True)),
            }
    except (RuntimeWarning, ValueError, IndexError, FloatingPointError, ZeroDivisionError) as error:
        raise MetricInputError("insufficient_audio", "유효 발화가 너무 짧거나 수치 계산이 불가능합니다. 음원과 비발화 구간을 확인하세요.") from error
    for key, value in result.items():
        if not math.isfinite(value) or abs(value) > 1 + 1e-12:
            raise MetricInputError("invalid_result", f"{key.upper()}: 유효한 점수가 산출되지 않았습니다.")
        # 수학적 범위 [-1, 1]의 경계를 미세하게 벗어난 부동소수점 오차만 보정한다.
        result[key] = min(1.0, max(-1.0, value))
    return result


@dataclass(frozen=True)
class _Wav:
    """읽은 파형·원본 샘플레이트·파일 지문을 함께 보관하는 내부 자료형이다."""

    signal: np.ndarray
    sample_rate: int
    sha256: str


def _read_wav(path: str | Path) -> _Wav:
    """실제 단일 채널 WAV 형식을 검사하고 파형과 원본 바이트의 SHA-256을 읽는다."""
    source = Path(path)
    if source.suffix.lower() != ".wav":
        raise MetricInputError("wav_format", f"WAV 파일이 필요합니다: {source}")
    try:
        # 한 번 읽은 동일한 파일 바이트로 파형을 해석하고 파일 지문도 계산한다.
        data = source.read_bytes()
        with sf.SoundFile(io.BytesIO(data)) as audio:
            if audio.format not in {"WAV", "WAVEX", "RF64"}:
                raise MetricInputError("wav_format", f"실제 WAV 형식이 아닙니다: {source}")
            if audio.channels != 1:
                raise MetricInputError("channels", f"mono WAV만 지원합니다: {source}")
            samples = audio.read(dtype="float64", always_2d=False)
            rate = audio.samplerate
    except FileNotFoundError as error:
        raise MetricInputError("file_missing", f"음원 파일이 없습니다: {source}") from error
    except (OSError, RuntimeError, sf.LibsndfileError) as error:
        raise MetricInputError("wav_read", f"WAV를 읽지 못했습니다: {source}") from error
    return _Wav(samples, rate, hashlib.sha256(data).hexdigest())


def _calculate_pair(
    reference: _Wav,
    target: _Wav,
    *,
    sample_rate: int,
    max_delay_seconds: float,
) -> tuple[dict[str, float], dict[str, Any]]:
    """읽어 둔 WAV 한 쌍을 준비한 뒤 두 점수와 전처리 내역을 함께 반환한다."""
    clean, compared, preparation = prepare_signals(
        reference.signal, target.signal, reference.sample_rate, target.sample_rate,
        sample_rate=sample_rate, max_delay_seconds=max_delay_seconds,
    )
    return calculate_signals(clean, compared, sample_rate), preparation


def calculate_wav_pair(
    clean_path: str | Path,
    compared_path: str | Path,
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    max_delay_seconds: float = DEFAULT_MAX_DELAY_SECONDS,
) -> dict[str, float]:
    """WAV 두 개를 읽고 리샘플링·정렬·평가한 뒤 두 점수만 반환한다. 파일 저장은 없다."""
    scores, _ = _calculate_pair(
        _read_wav(clean_path), _read_wav(compared_path),
        sample_rate=sample_rate, max_delay_seconds=max_delay_seconds,
    )
    return scores


def _expected_samples() -> dict[str, dict[str, Any]]:
    """실험 설계에 맞는 기준 3개와 평가 후보 180개의 ID·조건을 만든다.

    이 목록은 등록 정보 검증용이며 모든 WAV가 실제로 준비됐다는 뜻은 아니다.
    """
    expected = {}
    for statement, speaker in STATEMENTS.items():
        expected[f"clean_{statement}"] = dict(kind="clean", statement=statement, speaker=speaker, noise=None, snr=None, algorithm="clean")
        for noise in NOISES:
            for snr in SNRS:
                for algorithm in ALGORITHMS:
                    kind = "noisy" if algorithm == "noisy" else "processed"
                    sample_id = f"{noise}_snr{snr:02d}_{statement}_{algorithm}"
                    expected[sample_id] = dict(kind=kind, statement=statement, speaker=speaker, noise=noise, snr=snr, algorithm=algorithm)
    return expected


def _load_layout(root: Path) -> dict[str, Any]:
    try:
        layout = json.loads((root / "experiment/config/paths.json").read_text(encoding="utf-8-sig"))
        if layout.get("version") != 1 or not isinstance(layout.get("audio_roots"), list):
            raise ValueError("Unsupported layout")
        return layout
    except (OSError, ValueError, AttributeError) as error:
        raise MetricInputError("layout", "experiment/config/paths.json 경로 설정을 확인하세요.") from error


def _project_wav_path(value: Any, root: Path, layout: dict[str, Any] | None = None) -> tuple[str, Path]:
    """안정된 공개 음원 경로를 실제 experiment/ 저장 위치로 해석한다."""
    if not isinstance(value, str) or not value.strip():
        raise MetricInputError("manifest_path", "음원 경로가 비어 있습니다.")
    relative = value.strip().replace("\\", "/")
    parts = relative.split("/")
    if parts[0] not in {"data", "outputs"} or any(not part or part.startswith(".") for part in parts) or any(char in relative for char in ":?#%\x00") or not relative.lower().endswith(".wav"):
        raise MetricInputError("manifest_path", f"프로젝트 안의 data/ 또는 outputs/ WAV 상대 경로가 필요합니다: {relative}")
    # 경로를 실제 절대 경로로 해석한 뒤에도 프로젝트 밖으로 벗어나지 않는지 확인한다.
    layout = layout if layout is not None else _load_layout(root)
    mappings = [entry for entry in layout["audio_roots"] if isinstance(entry, dict) and isinstance(entry.get("public"), str) and relative.startswith(entry["public"] + "/")]
    if len(mappings) != 1 or not isinstance(mappings[0].get("source"), str):
        raise MetricInputError("manifest_path", f"등록된 연구 음원 경로가 아닙니다: {relative}")
    entry = mappings[0]
    source = entry["source"]
    if any(not part or part in {".", ".."} for part in source.split("/")) or ":" in source or "\\" in source:
        raise MetricInputError("layout", "실제 저장 경로는 프로젝트 내부 상대 경로여야 합니다.")
    absolute = (root / source / relative[len(entry["public"]) + 1:]).resolve()
    if not absolute.is_relative_to(root):
        raise MetricInputError("manifest_path", f"프로젝트 밖의 음원은 사용할 수 없습니다: {relative}")
    return relative, absolute


def resolve_audio_path(value: str, root: str | Path = PROJECT_ROOT) -> Path:
    return _project_wav_path(value, Path(root).resolve())[1]


def _load_manifest(manifest_path: str | Path, root: Path) -> dict[str, dict[str, Any]]:
    """음원 목록 JSON을 읽어 ID 중복·실험 조건·경로의 일치 여부를 확인한다."""
    try:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise MetricInputError("manifest", "음원 경로 JSON을 읽지 못했습니다.") from error
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("samples"), list):
        raise MetricInputError("manifest", "version 1의 samples 배열이 필요합니다.")
    expected, samples = _expected_samples(), {}
    layout = _load_layout(root)
    for entry in manifest["samples"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise MetricInputError("manifest", "음원 ID가 필요합니다.")
        sample_id = entry["id"]
        if sample_id not in expected or sample_id in samples:
            raise MetricInputError("manifest", f"알 수 없거나 중복된 음원 ID입니다: {sample_id}")
        # 문장·녹음자·소음·SNR·처리 방식이 ID에 해당하는 확정 조건과 일치해야 한다.
        for key, value in expected[sample_id].items():
            if key not in entry or type(entry[key]) is not type(value) or entry[key] != value:
                raise MetricInputError("manifest", f"{sample_id}: 선정된 문장·녹음자·조건과 {key} 값이 일치하지 않습니다.")
        relative, absolute = _project_wav_path(entry.get("path"), root, layout)
        samples[sample_id] = {**entry, "path": relative, "absolute_path": absolute}
    # 목록에는 전체 설계를 요구하지만 실제 WAV 읽기는 선택된 계산 대상에 대해서만 한다.
    if samples.keys() != expected.keys():
        raise MetricInputError("manifest", "기준 3개·무처리 36개·처리 결과 144개의 음원 ID가 모두 필요합니다.")
    paths = [entry["absolute_path"] for entry in samples.values()]
    if len(set(paths)) != len(paths):
        raise MetricInputError("manifest", "서로 다른 음원 ID에 같은 WAV 경로가 등록되어 있습니다.")
    return samples


def calculate_dataset(
    manifest_path: str | Path = DEFAULT_MANIFEST,
    *,
    root: str | Path = PROJECT_ROOT,
    sample_ids: list[str] | None = None,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    max_delay_seconds: float = DEFAULT_MAX_DELAY_SECONDS,
) -> list[dict[str, Any]]:
    """전체 평가 후보 180개 또는 선택한 일부를 계산해 결과 목록을 반환한다.

    이 함수는 파일을 저장하지 않는다. 하나라도 실패하면 BatchCalculationError에
    실패 목록을 담아 전달한다. 깨끗한 기준 음성과 소음 원본 자체는 평가 대상이 아니다.
    CLI에서 --algorithm noisy --algorithm ss_fixed로 준비된 72개를 선택한다.
    """
    root = Path(root).resolve()
    samples = _load_manifest(manifest_path, root)
    # 명시한 ID가 있으면 그 대상만, 없으면 무처리·처리 결과 전체를 선택한다.
    selected = list(sample_ids) if sample_ids is not None else [key for key, entry in samples.items() if entry["kind"] in {"noisy", "processed"}]
    if not selected or any(not isinstance(key, str) for key in selected) or len(set(selected)) != len(selected) or any(key not in samples or samples[key]["kind"] == "clean" for key in selected):
        raise MetricInputError("sample_selection", "중복 없이 무처리·처리 음원 ID를 선택하세요.")
    rows, errors, references = [], [], {}
    engine = tool_version()
    for sample_id in selected:
        sample = samples[sample_id]
        # 항상 같은 문장의 깨끗한 원음을 기준으로 삼는다.
        # 처리 음원을 무처리 음원과 직접 비교해 STOI를 계산하는 구조가 아니다.
        reference_id = f"clean_{sample['statement']}"
        reference_entry = samples[reference_id]
        try:
            # 여러 조건에서 재사용하는 기준 원음은 한 번만 읽어 보관한다.
            if reference_id not in references:
                references[reference_id] = _read_wav(reference_entry["absolute_path"])
            reference, target = references[reference_id], _read_wav(sample["absolute_path"])
            scores, preparation = _calculate_pair(reference, target, sample_rate=sample_rate, max_delay_seconds=max_delay_seconds)
            # 점수와 함께 입력 경로·파일 지문·정렬 내역·계산 시각을 한 행에 기록한다.
            rows.append(dict(
                sample_id=sample_id, **scores, tool_version=engine, reference_id=reference_id,
                reference_path=reference_entry["path"], compared_path=sample["path"],
                reference_sha256=reference.sha256, compared_sha256=target.sha256,
                **preparation, calculated_at=datetime.now(timezone.utc).isoformat(),
            ))
        except MetricInputError as error:
            errors.append(dict(sample_id=sample_id, code=error.code, message=str(error)))
    # 일부 성공값만 새 결과로 저장하지 않도록 전체 실패 목록을 호출자에게 전달한다.
    if errors:
        raise BatchCalculationError(errors)
    return rows


def write_results(rows: list[dict[str, Any]], output_dir: str | Path) -> tuple[Path, Path]:
    """결과를 검사하고 두 임시 파일을 완성한 뒤 CSV와 JSON 순서로 교체한다."""
    if not rows:
        raise MetricInputError("empty_results", "실제 계산 결과가 없어서 저장하지 않았습니다.")
    # 저장 직전에도 음원 ID의 유효성·중복과 두 점수의 수치 범위를 확인한다.
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("sample_id"), str) or row.get("sample_id") in seen or row.get("sample_id") not in _expected_samples() or _expected_samples()[row["sample_id"]]["kind"] == "clean":
            raise MetricInputError("invalid_results", "결과 음원 ID를 확인하세요.")
        seen.add(row["sample_id"])
        for key in ("stoi", "estoi"):
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not -1 <= value <= 1:
                raise MetricInputError("invalid_results", "실제 유효한 두 지표가 모두 필요합니다.")
    output = Path(output_dir)
    json_text = json.dumps(rows, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    output.mkdir(parents=True, exist_ok=True)
    staged = []
    try:
        # 같은 출력 폴더에 두 형식을 먼저 완성한다.
        # CSV에는 Excel 등에서 한국어를 읽기 쉽도록 UTF-8 BOM을 넣는다.
        for suffix in ("csv", "json"):
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8-sig" if suffix == "csv" else "utf-8", newline="", prefix=".stoi-estoi-", suffix=".tmp", dir=output, delete=False) as handle:
                staged.append(Path(handle.name))
                if suffix == "csv":
                    writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
                    writer.writeheader()
                    writer.writerows(rows)
                else:
                    handle.write(json_text)
                # 메모리 버퍼와 운영체제 버퍼의 내용을 파일에 기록한 뒤 교체한다.
                handle.flush()
                os.fsync(handle.fileno())
        csv_path, json_path = output / "metrics.csv", output / "metrics.json"
        # 각 파일을 개별 교체하며, 홈페이지 기본 입력인 JSON을 마지막에 반영한다.
        os.replace(staged[0], csv_path)
        os.replace(staged[1], json_path)
        return csv_path, json_path
    finally:
        # 성공·실패 여부와 관계없이 남아 있는 임시 파일을 정리한다.
        for temporary in staged:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    """명령행 옵션을 받아 계산·저장을 실행하고 성공 0 또는 실패 1을 반환한다."""
    # 터미널과 다른 프로그램에서 한글 메시지를 UTF-8로 받을 수 있게 한다.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    # 음원 목록·프로젝트 경로·저장 위치·처리 방식·정렬 조건을 명령행에서 지정할 수 있다.
    parser = argparse.ArgumentParser(description="선정 WAV의 실제 STOI·ESTOI를 계산합니다.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--algorithm", action="append", choices=ALGORITHMS, help="준비된 방식만 계산합니다. 여러 번 지정할 수 있습니다.")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help="계산 전 공통 샘플레이트. 기본 16000 Hz.")
    parser.add_argument("--max-delay-seconds", type=float, default=DEFAULT_MAX_DELAY_SECONDS, help="고정 지연 탐색 범위. 기본 ±0.5초, 0이면 시작 시점을 유지합니다.")
    parser.add_argument("--prefilter-bpf", action="store_true", help="등록된 새 144조건의 원본/BPF를 같은 Clean 구간으로 비교해 별도 회차에 보존합니다.")
    args = parser.parse_args(argv)
    if args.prefilter_bpf:
        from .prefilter_metrics import generate
        try:
            result = generate(args.root,sample_rate=args.sample_rate,max_delay_seconds=args.max_delay_seconds)
        except (ValueError,OSError) as error:
            print(json.dumps({'status':'error','message':str(error)},ensure_ascii=False),file=sys.stderr)
            return 1
        print(json.dumps(result,ensure_ascii=False))
        return 0
    try:
        # --algorithm을 여러 번 지정하면 해당 방식들의 ID를 합쳐 선택한다.
        # Python 모듈을 옵션 없이 직접 실행하면 전체 180개가 대상이 된다.
        selected = [key for key, entry in _expected_samples().items() if entry['algorithm'] in args.algorithm] if args.algorithm else None
        rows = calculate_dataset(
            args.manifest, root=args.root, sample_ids=selected,
            sample_rate=args.sample_rate, max_delay_seconds=args.max_delay_seconds,
        )
        # 모든 선택 음원의 계산이 끝난 뒤에만 결과 저장 단계로 넘어간다.
        csv_path, json_path = write_results(rows, args.output_dir)
    except BatchCalculationError as error:
        print(json.dumps({"status": "error", "message": str(error), "errors": error.errors}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (MetricInputError, OSError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "calculated": len(rows), "csv": str(csv_path), "json": str(json_path)}, ensure_ascii=False))
    return 0


# 모듈을 직접 실행했을 때만 명령행 처리를 시작한다. import 시에는 실행하지 않는다.
if __name__ == "__main__":
    raise SystemExit(main())
