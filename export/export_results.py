"""Export completed data to website/public/dataset without calculating metrics."""

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import subprocess
import tempfile
import uuid
import wave

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAX_AUDIO_BYTES = 25 * 1024 * 1024


def project_path(root, relative):
    if not isinstance(relative, str) or not relative or any(c in relative for c in ":\\?#%\x00"):
        raise ValueError("Project-relative paths are required.")
    if any(not part or part.startswith(".") for part in relative.split("/")):
        raise ValueError("Paths must remain inside the project.")
    target = root / relative
    if not target.resolve().is_relative_to(root) or target.resolve() != target.absolute():
        raise ValueError("Symlinks and paths outside the project are not supported.")
    return target


def load_json(filename):
    return json.loads(filename.read_text(encoding="utf-8-sig"))


def audio_path(root, relative, layout):
    if not isinstance(relative, str) or not relative.lower().endswith(".wav"):
        raise ValueError("A manifest WAV path is required.")
    project_path(root, relative)
    matches = [entry for entry in layout["audio_roots"] if relative.startswith(entry["public"] + "/")]
    if len(matches) != 1:
        raise ValueError(f"Unregistered audio path: {relative}")
    entry = matches[0]
    return project_path(root, entry["source"] + relative[len(entry["public"]):])


def validate_manifest(manifest, root, layout):
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("samples"), list):
        raise ValueError("A version 1 manifest with samples is required.")
    samples, paths = {}, set()
    for entry in manifest["samples"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"] or entry["id"] in samples:
            raise ValueError("Manifest sample IDs must be present and unique.")
        if entry.get("kind") not in {"clean", "noisy", "processed"} or not isinstance(entry.get("statement"), str) or not entry["statement"]:
            raise ValueError("Sample kind and statement are required.")
        relative = entry.get("path")
        audio_path(root, relative, layout)
        if relative in paths:
            raise ValueError("Different samples cannot share one WAV path.")
        paths.add(relative)
        samples[entry["id"]] = entry
    sources = manifest.get("noise_sources", [])
    if not isinstance(sources, list):
        raise ValueError("noise_sources must be an array.")
    source_ids = set(samples)
    for entry in sources:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"] or entry["id"] in source_ids:
            raise ValueError("Noise source IDs must be unique.")
        source_ids.add(entry["id"])
        audio_path(root, entry.get("path"), layout)
        paths.add(entry["path"])
    return samples, paths


def validate_metrics(rows, samples, catalog):
    if not isinstance(rows, list) or not rows and any(sample["kind"] != "clean" for sample in samples.values()):
        raise ValueError("Completed metric rows are required; calculate them separately first.")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each metric must be an object.")
        sample_id = row.get("sample_id")
        if not isinstance(sample_id, str):
            raise ValueError("A metric sample ID is required.")
        sample = samples.get(sample_id)
        if not sample or sample["kind"] == "clean" or sample_id in seen:
            raise ValueError("Metric IDs must be unique evaluation samples in the manifest.")
        seen.add(sample_id)
        for key in ("stoi", "estoi"):
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not -1 <= value <= 1:
                raise ValueError(f"{sample_id}: valid numeric STOI and ESTOI are required.")
        reference_id = "clean_" + sample["statement"]
        reference = samples.get(reference_id)
        if not reference or reference["kind"] != "clean" or row.get("reference_id") != reference_id:
            raise ValueError(f"{sample_id}: clean reference does not match the statement.")
        for key, expected in (("reference_path", reference["path"]), ("compared_path", sample["path"])):
            if row.get(key) != expected:
                raise ValueError(f"{sample_id}: metric paths do not match the manifest.")
            digest = row.get(key.replace("_path", "_sha256"))
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or catalog.get(expected) != digest:
                raise ValueError(f"{sample_id}: WAV missing or changed since metric calculation.")
        if not isinstance(row.get("tool_version"), str) or not row["tool_version"].strip():
            raise ValueError(f"{sample_id}: calculation tool version is required.")
        if any(type(row.get(key)) is not int or row[key] <= 0 for key in ("sample_rate", "samples")):
            raise ValueError(f"{sample_id}: calculation sample rate and length are required.")
        try:
            datetime.fromisoformat(row["calculated_at"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{sample_id}: valid calculation time is required.") from error


def write_json(filename, value):
    filename.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def export_noise_analysis(root, stage, manifest, catalog):
    """Copy completed graphs with matching source and artifact hashes; never run analysis."""
    source = project_path(root, "experiment/outputs/noise_analysis/results.json")
    if not source.exists():
        return {"sources": 0, "graphs": 0}
    data = load_json(source)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("A version 1 completed noise analysis is required.")
    sources, mixtures = data.get("sources"), data.get("mixtures")
    if not isinstance(sources, list) or not isinstance(mixtures, list):
        raise ValueError("Noise analysis sources and mixtures must be arrays.")
    samples = {row["id"]: row for row in manifest["samples"] + manifest.get("noise_sources", [])}
    records = sources + mixtures + ([data["overview"]] if data.get("overview") is not None else [])
    images = set()
    def add_image(image):
        if image is None:
            return
        if not isinstance(image, str) or not re.fullmatch(r"graphs/[a-zA-Z0-9_./-]+\.(png|svg|webp)", image, re.I):
            raise ValueError("Noise analysis graph paths must be inside graphs/.")
        project_path(root, image)
        images.add(image)
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("inputs"), list) or not record["inputs"]:
            raise ValueError("Noise analysis input fingerprints are required.")
        for entry in record["inputs"]:
            sample = samples.get(entry.get("sample_id")) if isinstance(entry, dict) else None
            if not sample or catalog.get(sample["path"]) != entry.get("sha256") or not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256"))):
                raise ValueError("Noise analysis source WAV missing or changed since calculation.")
        add_image(record.get("spectrum_image"))
    for source_row in sources:
        analysis = source_row.get("analysis", {})
        if not isinstance(analysis, dict) or analysis.get("method") != "full_fft" or any(type(analysis.get(key)) is not int or analysis[key] <= 0 for key in ("sample_rate_hz", "sample_count", "fft_size")):
            raise ValueError("Whole-record FFT metadata is required.")
        if analysis["fft_size"] < analysis["sample_count"]:
            raise ValueError("FFT size must cover the complete source.")
        if "peaks" not in source_row or source_row["peaks"] is not None and not isinstance(source_row["peaks"], list):
            raise ValueError("Use null for pending peak detection or an array for completed detection.")
        add_image(source_row.get("peaks_image"))
        for peak in source_row["peaks"] or []:
            add_image(peak.get("zoom_image"))
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != images:
        raise ValueError("Each referenced analysis graph needs an artifact SHA-256.")
    destination = stage / "noise_analysis"
    destination.mkdir()
    for image in sorted(images):
        source_graph = project_path(root, "experiment/outputs/graphs/noise_analysis/" + image.removeprefix("graphs/"))
        contents = source_graph.read_bytes()
        if hashlib.sha256(contents).hexdigest() != artifacts[image]:
            raise ValueError("Noise analysis graph changed since plotting.")
        if image.lower().endswith(".png") and not contents.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("A valid PNG analysis graph is required.")
        target = project_path(destination, image)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
    write_json(destination / "results.json", data)
    return {"sources": len(sources), "graphs": len(images)}


def peak_details_for_web(data, source_hash, observations):
    """Copy C statistics into a compact web representation; retain full research output."""
    def summarize(signal, keep=None):
        tracks = signal["tracking"]
        return {"frame_count": signal["frame_count"], "peaks": signal["peaks"], "tracking": {
            "method": tracks["method"], "frame_count": signal["frame_count"],
            "interval_frame_count": tracks["interval_frame_count"], "peak_track_ids": tracks["peak_track_ids"],
            "tracks": [[t["id"], t["count"], t["mean_hz"], t["std_hz"], t["mean_width_hz"], t["appearance_percent"],
                        t["start_sec"], t["end_sec"], t["interval"]["count"], t["interval"]["appearance_percent"],
                        t["interval"]["mean_hz"], t["interval"]["std_hz"], t["interval"]["mean_width_hz"]]
                       for t in tracks["tracks"] if keep is None or t["id"] in keep]}}
    result = {"version": 1, "engine": data["engine"], "sample_count": data["sample_count"],
              "interval_sec": data.get("interval_sec"), "delivery": {"version": 1, "format": "track-summaries", "source_sha256": source_hash},
              "signal": summarize(data["signal"])}
    if "added_noise" in data:
        keep = set(data["added_noise"]["tracking"]["peak_track_ids"]) | {row["noise_track_id"] for row in observations}
        result["added_noise"] = summarize(data["added_noise"], keep)
    return result


def prefilter_initial_for_analysis(root, analysis, source_hash):
    """Deliver a validated initial design only with its original measured analysis."""
    path = project_path(root, "experiment/config/prefilter_initial.json")
    if not path.is_file():
        return None
    data = load_json(path)
    if (data.get("version") != 1 or data.get("status") != "initial" or data.get("filter_type") != "peaking_eq"
            or data.get("scope") != "fixed_per_noise" or data.get("bandwidth_definition") != "half_gain_db"
            or data.get("sample_rate_hz") != 16000 or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", str(data.get("analysis_run_id", "")))
            or not re.fullmatch(r"[a-f0-9]{64}", str(data.get("analysis_source_sha256", "")))):
        raise ValueError("Invalid initial EQ settings.")
    presets = data.get("presets", [])
    if (not isinstance(presets, list) or len(presets) != 3 or any(not isinstance(p, dict) for p in presets)
            or {p.get("noise") for p in presets} != {"single", "complex", "changing"}):
        raise ValueError("Three unique initial EQ presets are required.")
    for preset in presets:
        if (not re.fullmatch(r"p[1-8]", str(preset.get("source_peak_id", ""))) or
                any(type(preset.get(key)) not in (int, float) or not math.isfinite(preset[key])
                    for key in ("center_hz", "measured_width_hz", "bandwidth_hz", "q", "gain_db"))):
            raise ValueError("Invalid initial EQ parameters.")
        if (not 0 < preset["center_hz"] < 8000 or not 0 < preset["bandwidth_hz"] < 8000 or
                preset["measured_width_hz"] <= 0 or preset["q"] <= 0 or preset["gain_db"] >= 0):
            raise ValueError("Initial EQ parameters are outside their valid range.")
        q = math.sin(2 * math.pi * preset["center_hz"] / 16000) / (2 * math.tan(math.pi * preset["bandwidth_hz"] / 16000))
        if abs(q - preset["q"]) > 1e-7:
            raise ValueError("Initial EQ Q does not match its half-gain bandwidth.")
    if (data["analysis_run_id"] != analysis.get("engine", {}).get("run_id") or data["analysis_source_sha256"] != source_hash
            or data["sample_rate_hz"] != analysis["method"]["sample_rate_hz"]):
        return None
    for preset in presets:
        source = next((s for s in analysis["sources"] if s["noise"] == preset["noise"]), None)
        peak = next((p for p in source["peaks"] if p["id"] == preset["source_peak_id"]), None) if source else None
        if not peak or abs(peak["frequency_hz"] - preset["center_hz"]) >= 1e-7 or abs(peak["bandwidth_hz"] - preset["measured_width_hz"]) >= 1e-7:
            return None
    return data


def export_peak_analysis(root, stage, files):
    source = project_path(root, "experiment/outputs/peak_analysis/results.json")
    if not source.is_file():
        return 0
    data = load_json(source)
    initial = prefilter_initial_for_analysis(root, data, hashlib.sha256(source.read_bytes()).hexdigest())
    if initial is not None:
        data["prefilter_initial"] = initial
    if data.get("version") != 1 or len(data.get("conditions", [])) != 144 or len(data.get("files", [])) != 171:
        raise ValueError("A complete measured 144-condition peak analysis is required.")
    catalog = {entry["path"]: entry for entry in files}
    seen = set()
    for entry in data["files"]:
        relative = entry["path"]
        if relative in seen:
            raise ValueError("Duplicate peak-analysis input.")
        seen.add(relative)
        expected = "experiment/mixtures/" + relative.removeprefix("data/mixed/") if relative.startswith("data/mixed/") else "experiment/" + relative
        if entry.get("source") != expected or not relative.startswith(("data/clean/", "data/reference/", "data/noise/", "data/mixed/")):
            raise ValueError("Invalid peak-analysis source path.")
        contents = project_path(root, expected).read_bytes()
        fingerprint = hashlib.sha256(contents).hexdigest()
        if fingerprint != entry.get("sha256") or len(contents) != entry.get("size"):
            raise ValueError("Peak-analysis input changed since calculation.")
        if relative in catalog and catalog[relative]["sha256"] != fingerprint:
            raise ValueError("Existing snapshot and peak-analysis inputs conflict.")
        target = project_path(stage / "audio", relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
        catalog[relative] = {"path": relative, "sha256": fingerprint, "size": len(contents)}
    files[:] = sorted(catalog.values(), key=lambda entry: entry["path"])
    destination = stage / "peak_analysis"
    destination.mkdir(exist_ok=True)
    for relative, expected_hash in data.get("artifacts", {}).items():
        if not re.fullmatch(r"runs/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}/(?:graphs/[a-z0-9_]+\.png|details/[a-z0-9_]+\.json)", relative):
            raise ValueError("Invalid C analysis artifact path.")
        artifact = project_path(root, "experiment/outputs/peak_analysis/" + relative)
        contents = artifact.read_bytes()
        if hashlib.sha256(contents).hexdigest() != expected_hash:
            raise ValueError("Completed C analysis artifact changed after calculation.")
        if relative.endswith(".json"):
            detail = json.loads(contents)
            if detail.get("engine", {}).get("run_id") != data.get("engine", {}).get("run_id"):
                raise ValueError("C analysis artifact belongs to another run.")
            observations = next((row["observations"] for row in data["conditions"] if row.get("details") == relative), [])
            detail = peak_details_for_web(detail, expected_hash, observations)
            contents = (json.dumps(detail, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
            data["artifacts"][relative] = hashlib.sha256(contents).hexdigest()
        elif not contents.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("A valid completed C analysis PNG is required.")
        target = project_path(destination, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
    if data.get("engine"):
        data["delivery"] = {"version": 1, "format": "track-summaries", "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    write_json(destination / "results.json", data)
    return len(data["conditions"])


def export_mixture_summary(root, stage):
    """Use the shared schema validator to deliver completed C summary artifacts."""
    if not project_path(root, 'experiment/outputs/mixture_summary/results.json').is_file():
        return 0
    node = PROJECT_ROOT / '.tools/node-v22.23.4-win-x64/node.exe' if sys.platform == 'win32' else shutil.which('node')
    if not node:
        raise ValueError('Prepare Node.js before exporting mixture summaries.')
    environment = dict(os.environ)
    environment['PATH'] = str(Path(node).parent) + os.pathsep + environment.get('PATH', '')
    completed = subprocess.run([str(node), str(Path(__file__).with_name('mixture_summary.mjs')), '--root', str(root),
                                '--destination', str(stage)], capture_output=True, text=True, env=environment)
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or 'Completed mixture summary could not be verified.')
    return json.loads(completed.stdout)['groups']


def export_fixed_prefilter(root, stage, files, bpf=False):
    """Validate completed fixed-EQ WAVs through the same Node delivery path as local preparation."""
    if not project_path(root, 'experiment/outputs/bpf_results.json' if bpf else 'experiment/outputs/prefilter_results.json').is_file():
        return 0
    node = PROJECT_ROOT / '.tools/node-v22.23.4-win-x64/node.exe' if sys.platform == 'win32' else shutil.which('node')
    environment = dict(os.environ)
    environment['PATH'] = str(Path(node).parent) + os.pathsep + environment.get('PATH', '')
    arguments = [str(node), str(Path(__file__).with_name('bpf.mjs' if bpf else 'prefilter.mjs')), '--root', str(root), '--destination', str(stage)]
    if not bpf and project_path(root, 'experiment/outputs/bpf_results.json').is_file():
        arguments.append('--metadata-only')
    completed = subprocess.run(arguments, capture_output=True, text=True, env=environment)
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or 'Completed fixed EQ could not be verified.')
    payload = json.loads(completed.stdout)
    catalog = {entry['path']: entry for entry in files}
    for entry in payload['files']:
        if entry['path'] in catalog and catalog[entry['path']]['sha256'] != entry['sha256']:
            raise ValueError('Prefilter input fingerprint conflict.')
        catalog[entry['path']] = entry
    files[:] = sorted(catalog.values(), key=lambda entry: entry['path'])
    return payload['count']


def copy_clean_collection(root, stage, files):
    definition = project_path(root, "experiment/config/collection.json")
    if not definition.exists():
        return 0
    config = load_json(definition)
    expected = {kind + f"{number:02}" for kind in ("instruction", "warning") for number in range(1, 7)}
    records = config.get("recordings")
    if config.get("version") != 1 or not isinstance(records, list) or len(records) != 12 or {row.get("id") for row in records} != expected:
        raise ValueError("The twelve confirmed clean recording IDs are required.")
    if config.get("source_root") not in {"experiment/data/clean", "experiment/clean"}:
        raise ValueError("Clean recordings must come from the experiment clean folder.")
    catalog = {entry["path"]: entry for entry in files}
    exported = []
    for row in sorted(records, key=lambda value: value["id"]):
        identity = row["id"]
        category, number = identity[:-2], int(identity[-2:])
        speaker = "유채원" if number <= 3 else "김도연"
        if row.get("category") != category or row.get("speaker") != speaker or not isinstance(row.get("text"), str) or not row["text"].strip():
            raise ValueError("Clean recording category, speaker and text must match the confirmed assignment.")
        source = project_path(root, config["source_root"] + "/" + identity + ".wav")
        before = source.stat()
        if before.st_size > MAX_AUDIO_BYTES:
            raise ValueError("A clean recording must not exceed 25 MiB.")
        contents = source.read_bytes()
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(contents) != after.st_size:
            raise ValueError("Clean recording changed during export.")
        with wave.open(io.BytesIO(contents), "rb") as audio:
            rate, count, channels = audio.getframerate(), audio.getnframes(), audio.getnchannels()
            if channels != 1 or audio.getsampwidth() != 2 or rate <= 0 or count <= 0 or len(audio.readframes(count)) != count * 2:
                raise ValueError("A complete mono PCM16 clean WAV is required.")
        relative = "data/clean/" + identity + ".wav"
        target = project_path(stage / "audio", relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
        fingerprint = hashlib.sha256(contents).hexdigest()
        catalog[relative] = {"path": relative, "size": len(contents), "sha256": fingerprint}
        exported.append({**row, "path": relative, "sha256": fingerprint, "size": len(contents),
                         "sample_rate_hz": rate, "sample_count": count, "channels": channels,
                         "duration_seconds": count / rate})
    files[:] = sorted(catalog.values(), key=lambda entry: entry["path"])
    write_json(stage / "collection.json", {"version": 1, "recordings": exported})
    return len(exported)


def export_ss_fixed(root, stage, files):
    """Deliver the completed SS snapshot without recalculating audio or scores."""
    if not (root / "experiment/outputs/ss_fixed.json").exists():
        return
    node = PROJECT_ROOT / '.tools/node-v22.23.4-win-x64/node.exe' if sys.platform == 'win32' else shutil.which('node')
    if not node:
        raise ValueError('Prepare Node.js before exporting fixed SS results.')
    completed = subprocess.run([str(node), str(Path(__file__).with_name('ss_fixed.mjs')), '--root', str(root), '--destination', str(stage)], check=True, capture_output=True, text=True)
    delivered = json.loads(completed.stdout)
    existing = {file['path'] for file in files}
    if any(file['path'] in existing for file in delivered):
        raise ValueError('Duplicate SS audio path.')
    files.extend(delivered)


def export_results(root=PROJECT_ROOT):
    root = Path(root).resolve()
    layout = load_json(root / "experiment/config/paths.json")
    if not isinstance(layout, dict) or layout.get("version") != 1 or not isinstance(layout.get("audio_roots"), list):
        raise ValueError("A version 1 research path configuration is required.")
    prefixes = set()
    for entry in layout["audio_roots"]:
        if not isinstance(entry, dict) or entry.get("public") not in {"data/clean", "data/noise", "data/mixed", "outputs"} or entry["public"] in prefixes:
            raise ValueError("Public audio roots must be unique approved prefixes.")
        prefixes.add(entry["public"])
        source = project_path(root, entry.get("source"))
        if not source.is_relative_to(root / "experiment"):
            raise ValueError("Audio sources must belong to experiment/.")
        if any(part in {"noise_train", "noise_test"} for part in source.relative_to(root).parts):
            raise ValueError("Pattern registration and evaluation source noises are not public audio roots.")
    manifest = load_json(project_path(root, layout.get("manifest")))
    samples, audio_paths = validate_manifest(manifest, root, layout)
    metrics_file = project_path(root, layout.get("metric_results"))
    if metrics_file.exists():
        rows = load_json(metrics_file)
    elif any(sample["kind"] != "clean" for sample in samples.values()):
        raise ValueError("Completed metric rows are required; calculate them separately first.")
    else:
        rows = []
    public = project_path(root, "website/public")
    public.mkdir(parents=True, exist_ok=True)
    destination = project_path(root, "website/public/dataset")
    if destination.exists() and not destination.is_dir():
        raise ValueError("The exported dataset destination must be a directory.")
    stage = Path(tempfile.mkdtemp(prefix=".dataset-stage-", dir=public))
    backup = public / (".dataset-backup-" + uuid.uuid4().hex)
    try:
        (stage / "audio").mkdir()
        files = []
        for relative in sorted(audio_paths):
            source = audio_path(root, relative, layout)
            if not source.exists():
                continue
            before = source.stat()
            if before.st_size > MAX_AUDIO_BYTES:
                raise ValueError(f"{relative}: exported WAVs must be at most 25 MiB.")
            data = source.read_bytes()
            after = source.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(data) != after.st_size:
                raise ValueError(f"{relative}: source changed during export.")
            if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                raise ValueError(f"{relative}: RIFF/WAVE audio is required.")
            target = stage / "audio" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            files.append({"path": relative, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        fingerprints = {entry["path"]: entry["sha256"] for entry in files}
        validate_metrics(rows, samples, fingerprints)
        analysis = export_noise_analysis(root, stage, manifest, fingerprints)
        clean_recordings = copy_clean_collection(root, stage, files)
        peak_comparisons = export_peak_analysis(root, stage, files)
        export_mixture_summary(root, stage)
        export_fixed_prefilter(root, stage, files)
        export_fixed_prefilter(root, stage, files, bpf=True)
        export_ss_fixed(root, stage, files)
        write_json(stage / "audio/catalog.json", {"version": 1, "files": files})
        write_json(stage / "manifest.json", manifest)
        write_json(stage / "results.json", rows)
        write_json(stage / "export.json", {"version": 1, "exported_at": datetime.now(timezone.utc).isoformat(), "audio_files": len(files), "metric_rows": len(rows)})
        if destination.exists():
            destination.rename(backup)
        try:
            stage.rename(destination)
        except OSError:
            if backup.exists():
                backup.rename(destination)
            raise
        return {"audio": len(files), "metrics": len(rows), "clean_recordings": clean_recordings, "noise_analysis": analysis, "peak_comparisons": peak_comparisons, "destination": str(destination)}
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup.exists() and destination.exists():
            shutil.rmtree(backup)


def verified_snapshot(root):
    root = Path(root).resolve()
    destination = project_path(root, "website/public/dataset")
    layout = load_json(root / "experiment/config/paths.json")
    manifest = load_json(destination / "manifest.json")
    samples, _ = validate_manifest(manifest, root, layout)
    catalog = load_json(destination / "audio/catalog.json")
    if catalog.get("version") != 1 or not isinstance(catalog.get("files"), list):
        raise ValueError("An existing exported audio catalog is required.")
    fingerprints = {}
    for entry in catalog["files"]:
        relative = entry["path"]
        if relative in fingerprints or not relative.lower().endswith(".wav"):
            raise ValueError("Exported WAV paths must be unique.")
        source = project_path(destination / "audio", relative)
        contents = source.read_bytes()
        if len(contents) != entry["size"] or len(contents) < 12 or contents[:4] != b"RIFF" or contents[8:12] != b"WAVE" or hashlib.sha256(contents).hexdigest() != entry["sha256"]:
            raise ValueError("Existing exported WAV changed; preserve and repair the snapshot before updating analysis.")
        fingerprints[relative] = entry["sha256"]
    rows = load_json(destination / "results.json")
    validate_metrics(rows, samples, fingerprints)
    return destination, manifest, catalog, fingerprints, rows


def export_collection_only(root=PROJECT_ROOT):
    """Add current clean recordings while preserving completed experiment outputs."""
    root = Path(root).resolve()
    if not project_path(root, "experiment/config/collection.json").is_file():
        raise ValueError("A confirmed clean collection definition is required.")
    destination, _, catalog, _, rows = verified_snapshot(root)
    for path in destination.rglob("*"):
        if path.resolve() != path.absolute() or not path.resolve().is_relative_to(destination):
            raise ValueError("The existing snapshot must contain real project files only.")
    stage = Path(tempfile.mkdtemp(prefix=".dataset-stage-", dir=destination.parent))
    backup = destination.parent / (".dataset-backup-" + uuid.uuid4().hex)
    try:
        shutil.copytree(destination, stage, dirs_exist_ok=True)
        files = catalog["files"]
        count = copy_clean_collection(root, stage, files)
        write_json(stage / "audio/catalog.json", {"version": 1, "files": files})
        write_json(stage / "export.json", {"version": 1, "exported_at": datetime.now(timezone.utc).isoformat(),
                   "audio_files": len(files), "metric_rows": len(rows), "clean_recordings": count})
        destination.rename(backup)
        try:
            stage.rename(destination)
        except OSError:
            backup.rename(destination)
            raise
        return {"mode": "collection-only", "clean_recordings": count, "audio": len(files), "metrics": len(rows), "destination": str(destination)}
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup.exists() and destination.exists():
            shutil.rmtree(backup)


def export_analysis_only(root=PROJECT_ROOT):
    """Update analysis against the existing snapshot without replacing its audio or metrics."""
    root = Path(root).resolve()
    if not project_path(root, "experiment/outputs/noise_analysis/results.json").is_file():
        raise ValueError("Complete the C analysis and Python plotting steps first.")
    destination, manifest, _, fingerprints, rows = verified_snapshot(root)
    stage = Path(tempfile.mkdtemp(prefix=".noise-analysis-stage-", dir=destination.parent))
    target = project_path(destination, "noise_analysis")
    backup = destination.parent / (".noise-analysis-backup-" + uuid.uuid4().hex)
    try:
        analysis = export_noise_analysis(root, stage, manifest, fingerprints)
        if target.exists():
            target.rename(backup)
        try:
            (stage / "noise_analysis").rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise
        return {"mode": "noise-analysis-only", "audio": len(fingerprints), "metrics": len(rows),
                "noise_analysis": analysis, "destination": str(target)}
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup.exists() and target.exists():
            shutil.rmtree(backup)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--noise-analysis-only", action="store_true", help="Preserve the verified existing audio/metrics snapshot and update only noise analysis.")
    group.add_argument("--collection-only", action="store_true", help="Add the twelve clean recordings to the verified existing web snapshot.")
    args = parser.parse_args()
    try:
        operation = export_collection_only if args.collection_only else export_analysis_only if args.noise_analysis_only else export_results
        print(json.dumps(operation(args.root), ensure_ascii=False))
        return 0
    except (OSError, ValueError, wave.Error, EOFError) as error:
        print(f"Result export failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
