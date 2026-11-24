"""Inspect received mixtures without modifying audio or deciding DSP parameters."""

import argparse
from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import uuid
import wave

PROJECT_ROOT = Path(__file__).resolve().parents[2]
# Confirmed input design; DSP and SNR measurement methods remain undecided.
NOISES = ("single", "complex", "changing")
SNRS = (20, 10, 5, 0)


def project_path(root, relative):
    if not isinstance(relative, str) or not relative or any(c in relative for c in ":\\?#%\x00"):
        raise ValueError("Use a project-relative directory.")
    if any(not part or part.startswith(".") for part in relative.split("/")):
        raise ValueError("Paths must stay inside the project.")
    path = root / relative
    if path.resolve() != path.absolute() or not path.resolve().is_relative_to(root):
        raise ValueError("Symlinks and paths outside the project are unsupported.")
    return path


def inspect_wav(root, path):
    result = {"path": path.relative_to(root).as_posix()}
    try:
        project_path(root, result["path"])
        before = path.stat()
        contents = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(contents) != after.st_size:
            raise ValueError("File changed during inspection.")
        with wave.open(io.BytesIO(contents), "rb") as audio:
            count, rate = audio.getnframes(), audio.getframerate()
            channels, width = audio.getnchannels(), audio.getsampwidth()
            frames = audio.readframes(count)
            if not count or not rate or len(frames) != count * channels * width:
                raise ValueError("Empty or truncated PCM data.")
        full_scale = None
        if width == 2:
            samples = array("h", frames)
            if sys.byteorder != "little":
                samples.byteswap()
            full_scale = sum(value in (-32768, 32767) for value in samples)
        result.update(valid=True, sha256=hashlib.sha256(contents).hexdigest(), size=len(contents),
                      sample_rate_hz=rate, sample_count=count, channels=channels, bits=width * 8,
                      duration_seconds=count / rate, pcm16_full_scale_samples=full_scale,
                      c_fft_format_supported=channels == 1 and width == 2)
    except (OSError, ValueError, wave.Error, EOFError) as error:
        result.update(valid=False, error=str(error))
    return result


def inspect_dataset(root=PROJECT_ROOT):
    root = Path(root).resolve()
    definition = json.loads((root / "data/metadata/collection.json").read_text(encoding="utf-8-sig"))
    recordings = definition["recordings"]
    expected_ids = {category + f"{number:02}" for category in ("instruction", "warning") for number in range(1, 7)}
    if len(recordings) != 12 or {row["id"] for row in recordings} != expected_ids:
        raise ValueError("The confirmed twelve clean recording IDs are required.")
    clean_root = project_path(root, definition["source_root"])
    clean = {row["id"]: {**inspect_wav(root, clean_root / (row["id"] + ".wav")), "speaker": row["speaker"]} for row in recordings}
    folder = project_path(root, "data/mixtures")
    expected = {(noise, snr, identity) for noise in NOISES for snr in SNRS for identity in expected_ids}
    received, conditions, unmapped = [], defaultdict(list), []
    for path in sorted(folder.rglob("*")) if folder.exists() else []:
        if not path.is_file() or path.suffix.lower() != ".wav":
            continue
        row = inspect_wav(root, path)
        parts = path.relative_to(folder).parts
        match = re.fullmatch(r"snr(00|0|05|5|10|20)", parts[1]) if len(parts) == 3 else None
        key = (parts[0], int(match[1]), path.stem) if match else None
        if key in expected:
            noise, snr, identity = key
            row.update(noise=noise, declared_snr_db=snr, statement=identity, speaker=clean[identity]["speaker"],
                       reference_path=clean[identity]["path"], snr_verified=False)
            reference = clean[identity]
            if row["valid"] and reference["valid"]:
                row.update(sample_rate_differs_from_clean=row["sample_rate_hz"] != reference["sample_rate_hz"],
                           duration_difference_from_clean=row["duration_seconds"] - reference["duration_seconds"])
            conditions[key].append(row["path"])
        else:
            unmapped.append(row["path"])
        received.append(row)
    missing = [{"noise": noise, "declared_snr_db": snr, "statement": identity} for noise, snr, identity in sorted(expected - conditions.keys())]
    duplicates = [{"noise": key[0], "declared_snr_db": key[1], "statement": key[2], "paths": paths}
                  for key, paths in sorted(conditions.items()) if len(paths) > 1]
    invalid = [row["path"] for row in [*clean.values(), *received] if not row["valid"]]
    review = invalid or duplicates or unmapped
    status = "needs_review" if review else "awaiting_files" if not received else "incomplete" if missing else "file_checks_complete"
    return {"version": 1, "inspected_at": datetime.now(timezone.utc).isoformat(), "status": status,
            "source_directory": "data/mixtures", "expected_mixtures": len(expected), "received_files": len(received),
            "matched_conditions": len(conditions), "missing_count": len(missing), "missing_conditions": missing,
            "duplicate_conditions": duplicates, "unmapped_files": unmapped, "invalid_files": invalid,
            "snr_status": "not_measured", "full_scale_note": "PCM full-scale touches are observations, not proof of clipping.",
            "clean_formats": [{"sample_rate_hz": rate, "channels": channels, "bits": bits, "files": total}
                              for (rate, channels, bits), total in sorted(Counter((row["sample_rate_hz"], row["channels"], row["bits"])
                              for row in clean.values() if row["valid"]).items())],
            "clean": list(clean.values()), "mixtures": received}


def save_report(root, report):
    root = Path(root).resolve()
    output = project_path(root, "experiment/validation")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    folder = output / run_id
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    fields = ["path", "valid", "noise", "declared_snr_db", "snr_verified", "statement", "speaker", "reference_path", "sample_rate_hz",
              "sample_count", "channels", "bits", "duration_seconds", "pcm16_full_scale_samples", "sha256", "error"]
    with (folder / "files.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report["mixtures"])
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--save", action="store_true", help="Save a new report.json and files.csv under outputs/validation/.")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        report = inspect_dataset()
        summary = {key: report[key] for key in ("status", "expected_mixtures", "received_files", "matched_conditions", "missing_count", "snr_status", "clean_formats")}
        if args.save:
            summary["report_directory"] = str(save_report(PROJECT_ROOT, report))
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"Mixture inspection failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
