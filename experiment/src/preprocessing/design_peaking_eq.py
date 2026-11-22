"""Compile/run the project-local C EQ designer and preserve design-only artifacts.

Python validates provenance and serializes/plots completed C values. It does not
calculate filter coefficients, responses, spectra, speech scores or audio.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "experiment/config/prefilter_fixed.json"
OUTPUT = ROOT / "experiment/outputs/prefilter_design"
CODE = Path(__file__).with_suffix(".c")
TOOL = "cnr-peaking-eq-design/1"
RUN_PATTERN = r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")


def project_path(path: Path) -> Path:
    path = Path(path).absolute()
    if path.resolve() != path or not path.is_relative_to(ROOT):
        raise ValueError("Design paths must stay inside this project without symlinks.")
    return path


def validate_settings(data):
    expected = {"version": 1, "status": "initial_design", "filter_type": "peaking_eq",
                "scope": "fixed_common", "connection": "cascade", "sample_rate_hz": 16000,
                "bandwidth_definition": "half_gain_db"}
    if not isinstance(data, dict) or any(type(data.get(k)) is not type(v) or data[k] != v for k, v in expected.items()):
        raise ValueError("Expected an initial common two-section peaking EQ at 16kHz.")
    sections = data.get("sections")
    if not isinstance(sections, list) or len(sections) != 2 or not all(isinstance(s, dict) for s in sections):
        raise ValueError("Exactly two EQ sections are required.")
    for index, section in enumerate(sections, 1):
        if section.get("id") != f"eq{index}" or type(section.get("order")) is not int or section["order"] != 2:
            raise ValueError("Sections must be ordered eq1/eq2 second-order biquads.")
        if any(type(section.get(k)) not in (int, float) or not math.isfinite(section[k])
               for k in ("center_hz", "bandwidth_hz", "q", "gain_db")):
            raise ValueError("EQ parameters must be finite real numbers.")
        if not (0 < section["center_hz"] < 8000 and 0 < section["bandwidth_hz"] < 8000 and
                section["q"] > 0 and section["gain_db"] < 0):
            raise ValueError("Invalid EQ center, bandwidth, Q or attenuation.")
        anchors = section.get("source_peaks")
        if not isinstance(anchors, list) or not anchors or any(
                not isinstance(p, dict) or p.get("noise") not in ("single", "complex", "changing") or
                not re.fullmatch(r"p[1-8]", str(p.get("peak_id", ""))) for p in anchors):
            raise ValueError("Each EQ needs original measured peak references.")
    if sections[0]["center_hz"] == sections[1]["center_hz"]:
        raise ValueError("The two EQ centers must be distinct.")
    if not isinstance(data.get("evaluation_relationship"), str) or not data["evaluation_relationship"].strip():
        raise ValueError("Record the relationship between design and evaluation data.")
    evidence = data.get("design_evidence")
    if not isinstance(evidence, list) or len(evidence) != 3 or not all(isinstance(e, dict) for e in evidence):
        raise ValueError("Three measured design evidence records are required.")
    if {e.get("role") for e in evidence} != {"peak_analysis", "mixture_summary", "peak_comparison"}:
        raise ValueError("Missing or duplicated design evidence roles.")
    for entry in evidence:
        if (not isinstance(entry.get("path"), str) or Path(entry["path"]).is_absolute() or
                not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256", ""))) or
                not re.fullmatch(RUN_PATTERN, str(entry.get("run_id", "")))):
            raise ValueError("Invalid evidence path, hash or run ID.")
        path = project_path(ROOT / entry["path"])
        if not path.is_relative_to(ROOT / "experiment/outputs"):
            raise ValueError("Design evidence must refer to completed experiment outputs.")
    return data


def verify_evidence(settings):
    records, decoded = [], {}
    for entry in settings["design_evidence"]:
        path = project_path(ROOT / entry["path"])
        contents = path.read_bytes()
        if hashlib.sha256(contents).hexdigest() != entry["sha256"]:
            raise ValueError(f"Design evidence changed: {entry['path']}")
        data = json.loads(contents.decode("utf-8-sig"))
        run = data.get("render_id") if entry["role"] == "peak_comparison" else data.get("engine", {}).get("run_id")
        if run != entry["run_id"]:
            raise ValueError("Evidence run ID does not match the selected analysis.")
        decoded[entry["role"]] = data
        records.append(dict(entry))
    hashes = {e["role"]: e["sha256"] for e in records}
    summary, comparison = decoded["mixture_summary"], decoded["peak_comparison"]
    if (summary.get("source_analysis", {}).get("sha256") != hashes["peak_analysis"] or
            comparison.get("source_analysis_sha256") != hashes["peak_analysis"] or
            comparison.get("source_summary_sha256") != hashes["mixture_summary"]):
        raise ValueError("Evidence files do not describe the same measured analysis.")
    for section in settings["sections"]:
        for anchor in section["source_peaks"]:
            source = next((s for s in decoded["peak_analysis"]["sources"] if s["noise"] == anchor["noise"]), None)
            peak = next((p for p in source["peaks"] if p["id"] == anchor["peak_id"]), None) if source else None
            if peak is None or abs(peak["frequency_hz"] - section["center_hz"]) > 1e-7:
                raise ValueError("EQ center does not match its selected original noise peak.")
    return records


def compile_designer(executable: Path):
    executable = project_path(executable)
    cache = ROOT / ".cache/noise_analysis"
    if not executable.is_relative_to(cache):
        raise ValueError("Compile the designer only inside the project analysis cache.")
    executable.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(ROOT / ".tools/tcc/tcc.exe"), "-std=c99", "-Wall", "-Werror",
                    str(CODE), "-o", str(executable)], check=True, cwd=ROOT)


def calculate(executable: Path, settings, response_path: Path):
    command = [str(executable), "--sample-rate", str(settings["sample_rate_hz"])]
    for section in settings["sections"]:
        command.extend(["--section", *(format(section[k], ".17g")
                                       for k in ("center_hz", "bandwidth_hz", "q", "gain_db"))])
    command.extend(["--response", str(response_path)])
    completed = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    raw = json.loads(completed.stdout)
    if raw.get("tool_version") != TOOL or raw.get("verification", {}).get("status") != "passed":
        raise ValueError("C designer did not return a verified design.")
    return raw


def render(raw, response_path: Path, directory: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    with response_path.open(encoding="ascii", newline="") as stream:
        rows = list(csv.DictReader(stream))
    if len(rows) != raw["response_rows"]:
        raise ValueError("Incomplete C response CSV.")
    frequencies = [float(row["frequency_hz"]) for row in rows]
    plots = [("response_full.png", "Full response", 0, raw["sample_rate_hz"] / 2)]
    for section in raw["sections"]:
        center, width = section["center_hz"], section["bandwidth_hz"]
        plots.append((f"response_{section['id']}.png", f"{section['id'].upper()}: {center:g} Hz", center - 3 * width, center + 3 * width))
    for filename, title, low, high in plots:
        figure, axes = plt.subplots(2, 1, figsize=(11, 6.5), sharex=True)
        try:
            for name, label, color, style in [("eq1", "EQ 1", "#28776e", "--"),
                                               ("eq2", "EQ 2", "#ae6d2f", "--"),
                                               ("cascade", "Cascade", "#263d65", "-")]:
                for axis, field in zip(axes, ("gain_db", "phase_deg")):
                    values = [float(row[f"{name}_{field}"]) for row in rows]
                    axis.plot(frequencies, values, label=label, color=color, linestyle=style, linewidth=1.5)
            for section in raw["sections"]:
                if low <= section["center_hz"] <= high:
                    axes[0].axvline(section["center_hz"], color="#888888", linewidth=.7, alpha=.6)
                    for edge in section["half_gain_edges_hz"]:
                        axes[0].plot(edge, section["gain_db"] / 2, "o", color="#555555", markersize=3)
            axes[0].set_ylabel("Gain (dB)")
            axes[0].set_ylim(min(s["gain_db"] for s in raw["sections"]) - .8, .5)
            axes[0].legend(loc="lower left", ncols=3)
            axes[1].set_ylabel("Phase (degrees)")
            axes[1].set_xlabel("Frequency (Hz)")
            axes[1].set_xlim(max(0, low), min(raw["sample_rate_hz"] / 2, high))
            for axis in axes:
                axis.grid(alpha=.2)
            figure.suptitle(f"Fixed peaking EQ design | {title}")
            figure.text(.5, .015, "C-computed frequency response; no audio filtering or performance evaluation.", ha="center", fontsize=9)
            figure.tight_layout(rect=(0, .035, 1, .95))
            figure.savefig(directory / filename, dpi=150)
        finally:
            plt.close(figure)
    return [filename for filename, *_ in plots]


def generate(*, config_path=CONFIG, output_root=OUTPUT, run_id=None):
    config_path, output_root = project_path(config_path), project_path(output_root)
    if not any(output_root.is_relative_to(ROOT / base) for base in ("experiment/outputs", ".cache")):
        raise ValueError("Design results must stay in experiment outputs or the project cache.")
    config_bytes = config_path.read_bytes()
    settings = validate_settings(json.loads(config_bytes.decode("utf-8-sig")))
    evidence = verify_evidence(settings)
    run_id = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    if not re.fullmatch(RUN_PATTERN, run_id):
        raise ValueError("Invalid design run ID.")
    destination = project_path(output_root / "runs" / run_id)
    if destination.exists():
        raise FileExistsError("A completed design run must never be overwritten.")
    cache = project_path(ROOT / ".cache/noise_analysis")
    cache.mkdir(parents=True, exist_ok=True)
    executable = cache / f"design_peaking_eq-{uuid.uuid4().hex[:12]}.exe"
    stage = Path(tempfile.mkdtemp(prefix="eq-design-stage-", dir=cache)).absolute()
    watched = [config_path, CODE, Path(__file__), ROOT / ".tools/tcc/tcc.exe"]
    initial_hashes = {path: digest(path) for path in watched}
    initial_hashes[config_path] = hashlib.sha256(config_bytes).hexdigest()
    try:
        compile_designer(executable)
        raw = calculate(executable, settings, stage / "response.csv")
        write_json(stage / "design.json", raw)
        graph_files = render(raw, stage / "response.csv", stage)
        if any(digest(path) != sha for path, sha in initial_hashes.items()):
            raise ValueError("Design code, configuration or compiler changed during calculation.")
        verify_evidence(settings)
        artifacts = {name: digest(stage / name) for name in ["design.json", "response.csv", *graph_files]}
        manifest = {"version": 1, "status": "design_verified", "run_id": run_id,
                    "calculated_at": datetime.now(timezone.utc).isoformat(),
                    "engine": {"language": "C", "tool_version": TOOL,
                               "source": CODE.relative_to(ROOT).as_posix(), "source_sha256": initial_hashes[CODE],
                               "executable": executable.relative_to(ROOT).as_posix(), "executable_sha256": digest(executable),
                               "runner_sha256": initial_hashes[Path(__file__)],
                               "compiler_sha256": initial_hashes[ROOT / ".tools/tcc/tcc.exe"]},
                    "config": {"path": config_path.relative_to(ROOT).as_posix(), "sha256": initial_hashes[config_path]},
                    "settings": settings, "design_evidence": evidence,
                    "evaluation_relationship": settings["evaluation_relationship"],
                    "actual_counts": {"eq_sections": 2, "response_rows": raw["response_rows"], "graphs": len(graph_files),
                                      "processed_wavs": 0, "objective_scores": 0, "listening_responses": 0},
                    "artifacts": artifacts}
        write_json(stage / "manifest.json", manifest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Recheck after rendering; rename must never replace a completed run.
        if destination.exists():
            raise FileExistsError("A completed design run must never be overwritten.")
        stage.rename(destination)
        return {"run_id": run_id, "manifest": str(destination / "manifest.json"),
                "actual_counts": manifest["actual_counts"]}
    finally:
        if stage.exists():
            if stage.resolve() != stage or stage.parent != cache or not stage.is_relative_to(ROOT):
                raise ValueError("Refusing to remove a staging directory outside the project cache.")
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    print(json.dumps(generate(), ensure_ascii=False))


if __name__ == "__main__":
    main()
