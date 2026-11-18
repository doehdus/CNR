"""Run the compiled C FFT on registered source noises; plotting is a separate step."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inside(root, relative):
    if not isinstance(relative, str) or not relative or any(c in relative for c in ":\\?#%\x00"):
        raise ValueError("A project-relative path is required.")
    if any(not part or part.startswith(".") for part in relative.split("/")):
        raise ValueError("Paths must stay inside the selected result directory.")
    path = root / relative
    if path.resolve() != path.absolute() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Symlinks and paths outside the project are unsupported.")
    return path


def publish_json(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        write_json(temporary, value)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def run_fft(root=PROJECT_ROOT):
    root = Path(root).resolve()
    config = load_json(root / "experiment/config/noise_analysis.json")
    if config != {"version": 1, "window_function": "hann_periodic", "peak_detection": "pending"}:
        raise ValueError("This stage supports the confirmed Hann FFT only; peak detection is pending.")
    layout = load_json(root / "experiment/config/paths.json")
    manifest = load_json(inside(root, layout["manifest"]))
    registered = manifest.get("noise_sources", [])
    expected = {"noise_single", "noise_complex", "noise_changing"}
    if {item["id"] for item in registered} != expected or len(registered) != len(expected):
        raise ValueError("The three registered source noises are required.")
    mappings = [row for row in layout["audio_roots"] if row["public"] == "data/noise"]
    if len(mappings) != 1 or mappings[0]["source"] != "experiment/data/noise":
        raise ValueError("Source noise mapping must refer to experiment/data/noise.")
    executable = root / ".cache/noise_analysis/noise_fft.exe"
    if not executable.is_file() or executable.resolve() != executable.absolute():
        raise ValueError("Compile noise_fft.c with the project-local compiler first.")
    cache = root / ".cache/noise_analysis"
    output = inside(root, "experiment/outputs/noise_analysis")
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="run-stage-", dir=cache))
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    destination = output / run_id
    try:
        rows = []
        for entry in registered:
            noise = entry["id"].removeprefix("noise_")
            if not entry["path"].startswith("data/noise/"):
                raise ValueError("Unregistered noise source path.")
            source = inside(root, "experiment/" + entry["path"])
            data = source.read_bytes()
            source_hash = hashlib.sha256(data).hexdigest()
            folder = stage / noise
            folder.mkdir()
            snapshot = folder / "input.wav"
            snapshot.write_bytes(data)
            subprocess.run([str(executable), "--input", str(snapshot), "--spectrum", str(folder / "spectrum.csv"),
                            "--metadata", str(folder / "metadata.json"), "--window", config["window_function"]], check=True)
            snapshot.unlink()
            if digest(source) != source_hash:
                raise ValueError("Source noise changed during FFT calculation.")
            rows.append({"noise": noise, "sample_id": entry["id"], "source": source.relative_to(root).as_posix(),
                         "sha256": source_hash, "spectrum": noise + "/spectrum.csv", "metadata": noise + "/metadata.json",
                         "spectrum_sha256": digest(folder / "spectrum.csv"), "metadata_sha256": digest(folder / "metadata.json")})
        record = {"version": 1, "run_id": run_id, "calculated_at": datetime.now(timezone.utc).isoformat(),
                  "executable_sha256": digest(executable),
                  "source_sha256_at_run": digest(root / "experiment/src/noise_analysis/noise_fft.c"),
                  "config": config, "sources": rows}
        write_json(stage / "manifest.json", record)
        stage.rename(destination)
        publish_json(output / "latest.json", {"version": 1, "manifest": run_id + "/manifest.json"})
        return {"sources": len(rows), "manifest": str(destination / "manifest.json")}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    print(json.dumps(run_fft(), ensure_ascii=False))
