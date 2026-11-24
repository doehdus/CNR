"""Draw whole-record spectra from saved C output, without calculating an FFT."""

import json
import math
import os
from pathlib import Path
import shutil
import tempfile

from analysis.mkgraphs.run_fft import PROJECT_ROOT, digest, inside, load_json, publish_json, write_json

os.environ.setdefault("MPLCONFIGDIR", str(PROJECT_ROOT / ".cache/matplotlib"))
import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib import font_manager
import numpy as np

LABELS = {"single": "단일 소음", "complex": "복합 소음", "changing": "변화 소음"}
COLORS = {"single": "#2563a6", "complex": "#b45b24", "changing": "#168572"}


def read_spectrum(folder, row):
    csv = inside(folder, row["spectrum"])
    metadata_file = inside(folder, row["metadata"])
    if digest(csv) != row["spectrum_sha256"] or digest(metadata_file) != row["metadata_sha256"]:
        raise ValueError("Saved C spectrum or metadata changed since calculation.")
    metadata = load_json(metadata_file)
    fs, count, size = (metadata[key] for key in ("sample_rate_hz", "sample_count", "fft_size"))
    if metadata.get("method") != "full_fft" or metadata.get("window_function") != "hann_periodic":
        raise ValueError("Expected a whole-record periodic Hann spectrum.")
    if any(type(number) is not int or number <= 0 for number in (fs, count, size)) or size < count or size & (size - 1):
        raise ValueError("Invalid FFT sampling metadata.")
    values = np.loadtxt(csv, delimiter=",", skiprows=1, ndmin=2)
    if values.shape != (size // 2 + 1, 4) or not np.isfinite(values).all():
        raise ValueError("A complete finite one-sided spectrum is required.")
    if not np.allclose(values[:, 0], np.arange(size // 2 + 1) * fs / size, rtol=0, atol=1e-9):
        raise ValueError("Spectrum frequencies do not match the FFT metadata.")
    if np.any(values[:, [1, 3]] < 0):
        raise ValueError("Amplitude and power density cannot be negative.")
    return metadata, values


def style_axes(ax, maximum_frequency, limits):
    ax.set(xlim=(0, maximum_frequency / 1000), ylim=limits, xlabel="주파수 (kHz)", ylabel="진폭 (dBFS)")
    ax.grid(axis="both", color="#e1e7ed", linewidth=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)


def draw_graphs(folder, spectra):
    try:
        font_manager.findfont("Malgun Gothic", fallback_to_default=False)
        plt.rcParams["font.family"] = "Malgun Gothic"
    except ValueError:
        plt.rcParams["font.family"] = "DejaVu Sans"
    plt.rcParams.update({"axes.unicode_minus": False, "font.size": 11, "path.simplify": False,
                         "savefig.dpi": 160, "figure.facecolor": "white"})
    minimum = min(float(values[:, 2].min()) for _, _, values in spectra)
    maximum = max(float(values[:, 2].max()) for _, _, values in spectra)
    limits = (math.floor(minimum / 10) * 10 - 5, max(0, math.ceil(maximum / 10) * 10))
    max_frequency = max(metadata["sample_rate_hz"] / 2 for _, metadata, _ in spectra)
    for row, metadata, values in spectra:
        noise = row["noise"]
        fig, ax = plt.subplots(figsize=(11, 5.5))
        fig.subplots_adjust(left=0.09, right=0.98, bottom=0.20, top=0.80)
        fig.suptitle(LABELS[noise] + " | 전체 음원 FFT", x=0.09, y=0.96, ha="left", fontsize=20, fontweight="bold")
        fig.text(0.09, 0.86, f"전체 {metadata['duration_seconds']:.2f}초 · {metadata['sample_rate_hz']:,} Hz · "
                 f"샘플 {metadata['sample_count']:,}개 · FFT {metadata['fft_size']:,}점", color="#526579")
        ax.plot(values[:, 0] / 1000, values[:, 2], color=COLORS[noise], linewidth=0.55)
        style_axes(ax, max_frequency, limits)
        fig.text(0.09, 0.08, "Hann 창(주기형) · 창 이득 보정 · 파일별 최대값 정규화 없음 · 주요 피크 검출 대기", fontsize=10)
        fig.text(0.09, 0.035, f"CSV 전체 주파수 빈 표시 · FFT 간격 {metadata['fft_bin_hz']:.5f} Hz · "
                 f"fs/N = {metadata['record_bin_hz']:.5f} Hz (영 채움은 실제 분해능을 높이지 않음)", fontsize=9, color="#526579")
        fig.savefig(folder / (noise + ".png"))
        plt.close(fig)
    fig, axes = plt.subplots(len(spectra), 1, figsize=(11, 10), sharex=True, sharey=True, squeeze=False)
    fig.subplots_adjust(left=0.09, right=0.98, bottom=0.12, top=0.88, hspace=0.42)
    fig.suptitle("3종 소음 | 전체 음원 FFT 비교", x=0.09, y=0.97, ha="left", fontsize=20, fontweight="bold")
    fig.text(0.09, 0.92, "같은 주파수·진폭 축과 디지털 풀스케일 기준 · 각 파일 전체를 한 번에 FFT", color="#526579")
    for ax, (row, _, values) in zip(axes[:, 0], spectra):
        ax.plot(values[:, 0] / 1000, values[:, 2], color=COLORS[row["noise"]], linewidth=0.55)
        style_axes(ax, max_frequency, limits)
        ax.set_title(LABELS[row["noise"]], loc="left", fontsize=13, fontweight="bold")
    fig.text(0.09, 0.04, "Hann 창(주기형) · 창 이득 보정 · 파일별 최대값 정규화 없음 · 주요 피크 검출 대기", fontsize=10)
    fig.savefig(folder / "comparison.png")
    plt.close(fig)


def plot_spectra(root=PROJECT_ROOT):
    root = Path(root).resolve()
    analysis_root = inside(root, "analysis/results/noise_analysis")
    latest = load_json(analysis_root / "latest.json")
    manifest_path = inside(analysis_root, latest["manifest"])
    manifest = load_json(manifest_path)
    run_id = manifest["run_id"]
    if inside(analysis_root, run_id) != manifest_path.parent or manifest["config"]["peak_detection"] != "pending":
        raise ValueError("The completed raw FFT run does not match its manifest.")
    rows = manifest["sources"]
    if len(rows) != 3 or {row["noise"] for row in rows} != set(LABELS):
        raise ValueError("The three source noise spectra are required.")
    spectra = []
    for row in rows:
        if digest(inside(root, row["source"])) != row["sha256"]:
            raise ValueError("Source noise changed since C analysis; calculate a new FFT run.")
        metadata, values = read_spectrum(manifest_path.parent, row)
        spectra.append((row, metadata, values))
    graph_root = inside(root, "analysis/graphs/noise_analysis")
    graph_root.mkdir(parents=True, exist_ok=True)
    destination = inside(graph_root, run_id)
    if destination.exists():
        raise ValueError("Graphs for this run already exist. Preserve them and start a new FFT run.")
    stage = Path(tempfile.mkdtemp(prefix="plot-stage-", dir=root / ".cache/noise_analysis"))
    try:
        draw_graphs(stage, spectra)
        sources = []
        for row, metadata, _ in spectra:
            parameters = {key: metadata[key] for key in ("method", "sample_rate_hz", "sample_count", "fft_size", "window_function", "magnitude_reference")}
            parameters["peak_rule"] = "주요 피크 검출 대기"
            sources.append({"noise": row["noise"], "inputs": [{"sample_id": row["sample_id"], "sha256": row["sha256"]}],
                            "analysis": parameters, "spectrum_image": f"graphs/{run_id}/{row['noise']}.png",
                            "peaks_image": None, "peaks": None, "candidates": [],
                            "summary": f"전체 {metadata['duration_seconds']:.2f}초에 Hann 창을 적용한 단일 FFT입니다. "
                                       "C 계산 CSV 전체를 그렸으며 주요 피크 검출은 대기 중입니다."})
        artifacts = {f"graphs/{run_id}/{file.name}": digest(file) for file in stage.glob("*.png")}
        result = {"version": 1, "sources": sources, "mixtures": [], "artifacts": artifacts,
                  "overview": {"inputs": [source["inputs"][0] for source in sources],
                               "spectrum_image": f"graphs/{run_id}/comparison.png",
                               "comparison_basis": "3종의 전체 음원을 같은 주파수·진폭 축으로 비교합니다. Hann 창 이득을 보정한 "
                                                   "디지털 풀스케일(dBFS) 기준이며, 파일별 최대값 정규화는 적용하지 않았습니다. "
                                                   "녹음 레벨에 영향을 받으므로 실제 현장의 음압 크기 비교를 의미하지 않습니다."}}
        write_json(manifest_path.parent / "results.json", result)
        stage.rename(destination)
        publish_json(analysis_root / "results.json", result)
        return {"graphs": len(artifacts), "destination": str(destination)}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    print(json.dumps(plot_spectra(), ensure_ascii=False))
