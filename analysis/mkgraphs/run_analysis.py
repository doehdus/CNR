"""Run C numerical analysis offline; preserve runs and publish verified artifacts.

Python handles input hashes, recorded metadata, serialization and plotting only.
All PSD, peak, tracking, energy and SNR values come from analyze_signals.c.
"""
from datetime import datetime, timezone
import csv
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from .plot_analysis import render_analysis

ROOT = Path(__file__).resolve().parents[2]
NOISES = ("single", "complex", "changing")
SNRS = (20, 10, 5, 0)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def payload(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate(root=ROOT):
    root = Path(root).resolve()
    executable = root / ".cache/noise_analysis/analyze_signals.exe"
    code = root / "analysis/mkgraphs/analyze_signals.c"
    config_path = root / "code/config/frequency_analysis.json"
    if not executable.is_file():
        raise ValueError("Compile analyze_signals.c with the project-local compiler first.")
    if executable.stat().st_mtime_ns < code.stat().st_mtime_ns:
        raise ValueError("C source changed; compile analyze_signals.c again before calculating.")
    config = read_json(config_path)
    if config.get("sample_rate_hz") != 16000 or config.get("nperseg") != 2048 or config.get("hop") != 1024:
        raise ValueError("The agreed analysis uses 16kHz, Hann 2048 and hop 1024.")
    collection = read_json(root / "data/metadata/collection.json")
    metadata = list(csv.DictReader((root / "data/preparation/tables/mixtures.csv").open(encoding="utf-8-sig")))
    if len(metadata) != 144 or len({r["file"] for r in metadata}) != 144:
        raise ValueError("The registered 144 unique mixture records are required.")
    registered = {r["file"]: r for r in metadata}
    files, sources, conditions, artifacts = {}, [], [], {}
    output = root / "analysis/results/peak_analysis"
    output.mkdir(parents=True, exist_ok=True)
    if output.resolve() != output.absolute():
        raise ValueError("Completed analysis must remain inside the project output directory.")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    stage = Path(tempfile.mkdtemp(prefix="analysis-stage-", dir=root / ".cache/noise_analysis"))
    prefix = "runs/" + run_id + "/"
    destination = output / "runs" / run_id
    engine = {"language": "C", "tool_version": "cnr-frequency-analysis/1", "run_id": run_id,
              "source_sha256": digest(code), "executable_sha256": digest(executable),
              "config_sha256": digest(config_path), "runner_sha256": digest(Path(__file__)),
              "plotter_sha256": digest(Path(__file__).with_name("plot_analysis.py")),
              "calculated_at": datetime.now(timezone.utc).isoformat()}

    def input_file(relative, public):
        path = root / relative
        if path.resolve() != path.absolute() or not path.is_file():
            raise ValueError("Analysis inputs must be regular project files.")
        files[public] = {"path": public, "source": relative, "sha256": digest(path), "size": path.stat().st_size}
        return path

    def artifact(path):
        relative = path.relative_to(stage).as_posix()
        artifacts[prefix + relative] = digest(path)
        return prefix + relative

    def calculate(path, name, extra=()):
        temporary = stage / "working.json"
        command = [str(executable), "--input", str(path), "--output", str(temporary),
                   "--prominence-db", str(config["prominence_db"]), "--distance-bins", str(config["minimum_distance_bins"]),
                   "--match-min-bins", str(config["matching_minimum_bins"]),
                   "--match-width-fraction", str(config["matching_width_fraction"]), *extra]
        subprocess.run(command, check=True)
        contents = temporary.read_bytes()
        result = json.loads(contents)
        if result.get("tool_version") != engine["tool_version"]:
            raise ValueError("Unexpected C calculation version.")
        raw_file = stage / "raw" / (name + ".json.gz")
        raw_file.parent.mkdir(parents=True, exist_ok=True)
        raw_file.write_bytes(gzip.compress(contents, mtime=0))
        temporary.unlink()
        return result

    def complete(raw, name):
        graphs = {key: artifact(path) for key, path in render_analysis(raw, stage / "graphs", name, name).items()}
        details = {"version": 1, "engine": engine, "sample_count": raw["sample_count"], "interval_sec": raw.get("interval_sec"),
                   "signal": {key: value for key, value in raw["signal"].items() if key != "spectrogram_db"}}
        for kind in ("speech", "added_noise"):
            if kind in raw:
                details[kind] = {key: value for key, value in raw[kind].items() if key != "spectrogram_db"}
        target = stage / "details" / (name + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload(details))
        return graphs, artifact(target)

    try:
        for row in collection["recordings"]:
            name = row["id"]
            input_file(f"{collection['source_root']}/{name}.wav", f"data/clean/{name}.wav")
            input_file(f"data/reference/{name}.wav", f"data/reference/{name}.wav")
        for noise in NOISES:
            path = input_file(f"data/noise/{noise}.wav", f"data/noise/{noise}.wav")
            raw = calculate(path, noise)
            graphs, details = complete(raw, noise)
            peaks = [dict(peak, time_change_db=change) for peak, change in zip(raw["signal"]["peaks"], raw["time_change_db"])]
            source = {"noise": noise, "psd_db": raw["signal"]["psd_db"], "peaks": peaks,
                      "before_psd_db": raw["before_psd_db"], "after_psd_db": raw["after_psd_db"],
                      "band_energy": raw["band_energy"], "graphs": graphs, "details": details}
            sources.append(source)
            anchors = stage / "anchors.csv"
            anchors.write_text("".join(f"{p['id'][1:]},{p['frequency_hz']},{p['bandwidth_hz']},{p['low_hz']},{p['high_hz']}\n" for p in peaks), encoding="ascii")
            for snr in SNRS:
                for recording in collection["recordings"]:
                    name = recording["id"]
                    relative = f"mixtures/{noise}/snr{snr:02d}/{name}.wav"
                    record = registered[relative]
                    path = input_file("experiment/" + relative, "data/mixed/" + relative.removeprefix("mixtures/"))
                    if digest(path) != record["sha256"]:
                        raise ValueError("Registered mixture changed: " + relative)
                    # Convert the already recorded interval to integer sample indices; no VAD is run here.
                    start = round(float(record["snr_interval_start_sec"]) * 16000)
                    end = round(float(record["snr_interval_end_sec"]) * 16000)
                    identity = f"{noise}_snr{snr:02d}_{name}"
                    measured = calculate(path, identity, ["--reference", str(root / f"data/reference/{name}.wav"),
                        "--start-sample", str(start), "--end-sample", str(end), "--anchors", str(anchors)])
                    if abs(measured["actual_snr_db"] - snr) > .015:
                        raise ValueError("Reference/SNR mismatch: " + relative)
                    graphs, details = complete(measured, identity)
                    conditions.append({"noise": noise, "snr": snr, "statement": name,
                        "actual_snr_db": measured["actual_snr_db"], "interval_sec": measured["interval_sec"],
                        "speech_db": measured["speech"]["psd_db"], "noise_db": measured["added_noise"]["psd_db"],
                        "mixture_db": measured["signal"]["psd_db"], "observations": measured["observations"],
                        "mixture_peaks": measured["signal"]["peaks"], "graphs": graphs, "details": details})
                print(f"C analysis completed: {noise}, {snr} dB ({len(conditions)}/144)", flush=True)
            anchors.unlink()
        for file in files.values():
            if digest(root / file["source"]) != file["sha256"]:
                raise ValueError("Input changed while calculating: " + file["source"])
        if digest(code) != engine["source_sha256"] or digest(executable) != engine["executable_sha256"] or digest(config_path) != engine["config_sha256"]:
            raise ValueError("Calculation code or configuration changed during this run.")
        result = {"version": 1, "status": "exploratory", "engine": engine,
            "frequency_hz": [i * 16000 / 2048 for i in range(1025)], "recordings": collection["recordings"],
            "sources": sources, "conditions": conditions, "files": list(files.values()), "artifacts": artifacts,
            "method": {"name": "Welch PSD", "sample_rate_hz": 16000, "nperseg": 2048, "noverlap": 1024,
                "window": "hann", "detrend": "constant", "unit": "dBFS/Hz", "prominence_db": config["prominence_db"],
                "minimum_distance_bins": config["minimum_distance_bins"], "max_source_peaks": 8,
                "width": "linear PSD half-prominence",
                "matching_tolerance": f"max({config['matching_minimum_bins']} bins, previous peak width * {config['matching_width_fraction']})",
                "matching_minimum_bins": config["matching_minimum_bins"], "matching_width_fraction": config["matching_width_fraction"],
                "tracking": "STFT -> per-frame peak detection -> adjacent-frame one-to-one matching -> trajectory statistics; no gap filling",
                "tracking_frame_selection": "all qualifying local peaks; power-ranked top 8 only for whole-record peak tables",
                "tracking_appearance": "trajectory point count / all full analysis frames; individual interrupted trajectories stay separate",
                "interval_frames": "frame center inside registered speech start/end interval; internal pauses included",
                "frame_policy": "full 2048-sample frames only; no padding; discard incomplete tail",
                "comparison_interval": "whole WAV for Welch; registered speech interval for SNR",
                "candidate_status": "exploratory measured peaks; no filter type/cutoff/Q/attenuation selected"}}
        (stage / "manifest.json").write_bytes(payload({"engine": engine, "config": config,
            "files": result["files"], "artifacts": artifacts}))
        destination.parent.mkdir(exist_ok=True)
        stage.rename(destination)
        target = output / "results.json"
        if target.exists():
            archive = output / ("results-" + digest(target)[:12] + ".json")
            if not archive.exists():
                shutil.copyfile(target, archive)
        temporary = output / ("results-" + uuid.uuid4().hex + ".tmp")
        temporary.write_bytes(payload(result)); temporary.replace(target)
        print(f"Published C analysis: 3 sources, {len(conditions)} conditions, {len(artifacts)} artifacts; {run_id}", flush=True)
        return result
    finally:
        if stage.exists():
            if stage.resolve().parent != (root / ".cache/noise_analysis").resolve():
                raise ValueError("Refusing to remove a staging path outside the analysis cache.")
            shutil.rmtree(stage)


if __name__ == "__main__":
    generate()
