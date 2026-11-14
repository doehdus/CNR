"""Compute real STOI/ESTOI scores; importing this module never writes results.

Public API: prepare_signals, calculate_signals, calculate_wav_pair, calculate_dataset,
write_results. Batch output is committed only after every requested pair passes.
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

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = PROJECT_ROOT / "data" / "metadata" / "dataset.json"
STATEMENTS = {"instruction_01": "유채원", "instruction_02": "유채원", "warning_01": "김도연"}
NOISES = ("single", "complex", "changing")
SNRS = (20, 10, 5, 0)
ALGORITHMS = ("noisy", "ss_fixed", "ss_pattern_fixed", "ss_pattern_update", "additional")
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_MAX_DELAY_SECONDS = 0.5
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
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class BatchCalculationError(ValueError):
    def __init__(self, errors: list[dict[str, str]]):
        self.errors = errors
        super().__init__(f"{len(errors)}개 음원을 계산하지 못했습니다. 결과 파일은 저장하지 않았습니다.")


def tool_version() -> str:
    if version("pystoi") != "0.4.1":
        raise MetricInputError("dependency_version", "이 프로젝트는 pystoi==0.4.1 환경을 사용해야 합니다.")
    return "; ".join(f"{name}/{version(name)}" for name in ("pystoi", "numpy", "scipy", "soundfile")) + "; cnr/2"


def _sample_rate(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral) or value <= 0:
        raise MetricInputError("sample_rate", "샘플레이트는 양의 정수여야 합니다.")
    return int(value)


def _signal(value: Any, label: str) -> np.ndarray:
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
    """Resample mono signals, estimate one constant delay, and retain the overlap.

    A positive delay means the compared signal lags behind the reference.
    Trim counts and delay are measured at the common output sample rate.
    Correlation uses mean-centered copies. Scoring retains the resampled audio.
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

    reference_centered = reference - reference.mean()
    target_centered = target - target.mean()
    correlation = correlate(target_centered, reference_centered, mode="full", method="fft")
    lags = correlation_lags(target.size, reference.size, mode="full")
    max_delay_samples = min(float(max_delay_seconds) * sample_rate, max(reference.size, target.size) - 1)
    candidates = np.flatnonzero(np.abs(lags) <= max_delay_samples)
    peak = candidates[np.argmax(np.abs(correlation[candidates]))]
    delay = int(lags[peak])

    reference_start = max(0, -delay)
    target_start = max(0, delay)
    samples = min(reference.size - reference_start, target.size - target_start)
    aligned_reference = _signal(reference[reference_start:reference_start + samples], "정렬된 기준 음성")
    aligned_target = _signal(target[target_start:target_start + samples], "정렬된 비교 음성")
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
    """Evaluate equal-length, time-aligned mono signals at a common sample rate.

    No alignment, padding, peak normalization, clipping, or channel averaging is
    applied. pystoi's specified internal resampling/silence removal is retained.
    """
    tool_version()
    sample_rate = _sample_rate(sample_rate)
    reference = _signal(clean, "기준 음성")
    target = _signal(compared, "비교 음성")
    if reference.size != target.size:
        raise MetricInputError("length_mismatch", "기준 음성과 비교 음성 길이가 다릅니다. 시간 정렬을 확인하세요.")
    try:
        with warnings.catch_warnings():
            # pystoi otherwise returns 1e-5 when fewer than 30 usable frames
            # remain. That sentinel must never become a research score.
            warnings.simplefilter("error", RuntimeWarning)
            result = {
                "stoi": float(reference_stoi(reference, target, int(sample_rate), extended=False)),
                "estoi": float(reference_stoi(reference, target, int(sample_rate), extended=True)),
            }
    except (RuntimeWarning, ValueError, IndexError, FloatingPointError, ZeroDivisionError) as error:
        raise MetricInputError("insufficient_audio", "유효 발화가 너무 짧거나 수치 계산이 불가능합니다. 음원과 비발화 구간을 확인하세요.") from error
    for key, value in result.items():
        if not math.isfinite(value) or abs(value) > 1 + 1e-12:
            raise MetricInputError("invalid_result", f"{key.upper()}: 유효한 점수가 산출되지 않았습니다.")
        # Correct only floating-point roundoff at the mathematical bounds.
        result[key] = min(1.0, max(-1.0, value))
    return result


@dataclass(frozen=True)
class _Wav:
    signal: np.ndarray
    sample_rate: int
    sha256: str


def _read_wav(path: str | Path) -> _Wav:
    source = Path(path)
    if source.suffix.lower() != ".wav":
        raise MetricInputError("wav_format", f"WAV 파일이 필요합니다: {source}")
    try:
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
    """Read, resample, align, and evaluate two WAV files without writes."""
    scores, _ = _calculate_pair(
        _read_wav(clean_path), _read_wav(compared_path),
        sample_rate=sample_rate, max_delay_seconds=max_delay_seconds,
    )
    return scores


def _expected_samples() -> dict[str, dict[str, Any]]:
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


def _project_wav_path(value: Any, root: Path) -> tuple[str, Path]:
    if not isinstance(value, str) or not value.strip():
        raise MetricInputError("manifest_path", "음원 경로가 비어 있습니다.")
    relative = value.strip().replace("\\", "/")
    parts = relative.split("/")
    if parts[0] not in {"data", "outputs"} or any(not part or part.startswith(".") for part in parts) or any(char in relative for char in ":?#%\x00") or not relative.lower().endswith(".wav"):
        raise MetricInputError("manifest_path", f"프로젝트 안의 data/ 또는 outputs/ WAV 상대 경로가 필요합니다: {relative}")
    absolute = (root / relative).resolve()
    if not absolute.is_relative_to(root):
        raise MetricInputError("manifest_path", f"프로젝트 밖의 음원은 사용할 수 없습니다: {relative}")
    return relative, absolute


def _load_manifest(manifest_path: str | Path, root: Path) -> dict[str, dict[str, Any]]:
    try:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise MetricInputError("manifest", "음원 경로 JSON을 읽지 못했습니다.") from error
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("samples"), list):
        raise MetricInputError("manifest", "version 1의 samples 배열이 필요합니다.")
    expected, samples = _expected_samples(), {}
    for entry in manifest["samples"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise MetricInputError("manifest", "음원 ID가 필요합니다.")
        sample_id = entry["id"]
        if sample_id not in expected or sample_id in samples:
            raise MetricInputError("manifest", f"알 수 없거나 중복된 음원 ID입니다: {sample_id}")
        for key, value in expected[sample_id].items():
            if key not in entry or type(entry[key]) is not type(value) or entry[key] != value:
                raise MetricInputError("manifest", f"{sample_id}: 선정된 문장·녹음자·조건과 {key} 값이 일치하지 않습니다.")
        relative, absolute = _project_wav_path(entry.get("path"), root)
        samples[sample_id] = {**entry, "path": relative, "absolute_path": absolute}
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
    """Evaluate the 180 study targets (or an explicit subset), without writes.

    Raises BatchCalculationError if any selected pair fails. Clean references
    and noise-only source recordings are never themselves scored.
    """
    root = Path(root).resolve()
    samples = _load_manifest(manifest_path, root)
    selected = list(sample_ids) if sample_ids is not None else [key for key, entry in samples.items() if entry["kind"] in {"noisy", "processed"}]
    if not selected or any(not isinstance(key, str) for key in selected) or len(set(selected)) != len(selected) or any(key not in samples or samples[key]["kind"] == "clean" for key in selected):
        raise MetricInputError("sample_selection", "중복 없이 무처리·처리 음원 ID를 선택하세요.")
    rows, errors, references = [], [], {}
    engine = tool_version()
    for sample_id in selected:
        sample = samples[sample_id]
        reference_id = f"clean_{sample['statement']}"
        reference_entry = samples[reference_id]
        try:
            if reference_id not in references:
                references[reference_id] = _read_wav(reference_entry["absolute_path"])
            reference, target = references[reference_id], _read_wav(sample["absolute_path"])
            scores, preparation = _calculate_pair(reference, target, sample_rate=sample_rate, max_delay_seconds=max_delay_seconds)
            rows.append(dict(
                sample_id=sample_id, **scores, tool_version=engine, reference_id=reference_id,
                reference_path=reference_entry["path"], compared_path=sample["path"],
                reference_sha256=reference.sha256, compared_sha256=target.sha256,
                **preparation, calculated_at=datetime.now(timezone.utc).isoformat(),
            ))
        except MetricInputError as error:
            errors.append(dict(sample_id=sample_id, code=error.code, message=str(error)))
    if errors:
        raise BatchCalculationError(errors)
    return rows


def write_results(rows: list[dict[str, Any]], output_dir: str | Path) -> tuple[Path, Path]:
    """Stage both formats, then publish the CSV and finally the default JSON."""
    if not rows:
        raise MetricInputError("empty_results", "실제 계산 결과가 없어서 저장하지 않았습니다.")
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
        for suffix in ("csv", "json"):
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8-sig" if suffix == "csv" else "utf-8", newline="", prefix=".stoi-estoi-", suffix=".tmp", dir=output, delete=False) as handle:
                staged.append(Path(handle.name))
                if suffix == "csv":
                    writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
                    writer.writeheader()
                    writer.writerows(rows)
                else:
                    handle.write(json_text)
                handle.flush()
                os.fsync(handle.fileno())
        csv_path, json_path = output / "stoi_estoi.csv", output / "stoi_estoi.json"
        os.replace(staged[0], csv_path)
        os.replace(staged[1], json_path)
        return csv_path, json_path
    finally:
        for temporary in staged:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="선정 WAV의 실제 STOI·ESTOI를 계산합니다.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--output-dir", type=Path, default=PROJECT_ROOT / "metrics" / "results")
    parser.add_argument("--algorithm", action="append", choices=ALGORITHMS, help="준비된 방식만 계산합니다. 여러 번 지정할 수 있습니다.")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help="계산 전 공통 샘플레이트. 기본 16000 Hz.")
    parser.add_argument("--max-delay-seconds", type=float, default=DEFAULT_MAX_DELAY_SECONDS, help="고정 지연 탐색 범위. 기본 ±0.5초, 0이면 시작 시점을 유지합니다.")
    args = parser.parse_args(argv)
    try:
        selected = [key for key, entry in _expected_samples().items() if entry['algorithm'] in args.algorithm] if args.algorithm else None
        rows = calculate_dataset(
            args.manifest, root=args.root, sample_ids=selected,
            sample_rate=args.sample_rate, max_delay_seconds=args.max_delay_seconds,
        )
        csv_path, json_path = write_results(rows, args.output_dir)
    except BatchCalculationError as error:
        print(json.dumps({"status": "error", "message": str(error), "errors": error.errors}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (MetricInputError, OSError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "calculated": len(rows), "csv": str(csv_path), "json": str(json_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
