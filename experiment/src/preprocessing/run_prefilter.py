"""Run the confirmed common EQ on all 144 mixtures; preserve WAV runs and hashes."""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from . import design_peaking_eq as designer

ROOT = designer.ROOT
CODE = Path(__file__).with_name("prefilter.c")


def selected_design():
    settings = designer.validate_settings(designer.read_json(designer.CONFIG))
    designer.verify_evidence(settings)
    manifests = sorted((ROOT / "experiment/outputs/prefilter_design/runs").glob("*/manifest.json"), reverse=True)
    for path in manifests:
        record = designer.read_json(path)
        if record["config"]["sha256"] != designer.digest(designer.CONFIG):
            continue
        if (record["settings"] != settings or record["engine"]["source_sha256"] != designer.digest(designer.CODE) or
                record["engine"]["runner_sha256"] != designer.digest(Path(designer.__file__))):
            raise ValueError("Selected EQ design code or settings changed; verify the design again.")
        for name, sha in record["artifacts"].items():
            if designer.digest(path.parent / name) != sha:
                raise ValueError("A verified design artifact changed.")
        raw = designer.read_json(path.parent / "design.json")
        return settings, path, record, raw
    raise ValueError("A completed verified design matching the fixed EQ settings is required.")


def filter_file(executable, source, target, sections):
    command = [str(executable), "--input", str(source), "--output", str(target)]
    for section in sections:
        command.extend(["--section", *(format(v, ".17g") for v in [*section["b"], *section["a"][1:]])])
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def generate():
    settings, design_path, design_record, design = selected_design()
    analysis_path = ROOT / "experiment/outputs/peak_analysis/results.json"
    analysis = designer.read_json(analysis_path)
    collection_path = ROOT / "experiment/config/collection.json"
    recordings = designer.read_json(collection_path)["recordings"]
    speakers = {r["id"]: r["speaker"] for r in recordings}
    conditions = analysis["conditions"]
    if len(conditions) != 144 or len({(c["noise"], c["snr"], c["statement"]) for c in conditions}) != 144:
        raise ValueError("Expected all 144 unique registered mixture conditions.")
    original_hashes = {f["path"]: f["sha256"] for f in analysis["files"]}
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    output = designer.project_path(ROOT / "experiment/outputs/enhanced/prefilter_fixed/runs" / run_id)
    cache = designer.project_path(ROOT / ".cache/noise_analysis")
    stage = Path(tempfile.mkdtemp(prefix="prefilter-stage-", dir=cache)).absolute()
    executable = cache / f"prefilter-{uuid.uuid4().hex[:12]}.exe"
    watched = [designer.CONFIG, CODE, Path(__file__), design_path, design_path.parent / "design.json", collection_path, analysis_path]
    hashes = {p: designer.digest(p) for p in watched}
    rows = []
    try:
        subprocess.run([str(ROOT / ".tools/tcc/tcc.exe"), "-std=c99", "-Wall", "-Werror", str(CODE), "-o", str(executable)], check=True)
        for row in conditions:
            suffix = f"{row['noise']}/snr{row['snr']:02d}/{row['statement']}.wav"
            logical_input = "data/mixed/" + suffix
            source = designer.project_path(ROOT / "experiment/mixtures" / suffix)
            if designer.digest(source) != original_hashes[logical_input]:
                raise ValueError("A registered mixture changed: " + suffix)
            target = stage / suffix
            target.parent.mkdir(parents=True, exist_ok=True)
            measured = filter_file(executable, source, target, design["sections"])
            if measured["tool_version"] != "cnr-fixed-prefilter/1" or measured["clipped_samples"] != 0:
                raise ValueError("Invalid C filter result.")
            if designer.digest(source) != original_hashes[logical_input]:
                raise ValueError("Mixture changed during filtering.")
            rows.append({"noise": row["noise"], "snr": row["snr"], "statement": row["statement"],
                         "speaker": speakers[row["statement"]], "input_path": logical_input,
                         "input_sha256": original_hashes[logical_input],
                         "output_path": f"outputs/prefilter_fixed/runs/{run_id}/{suffix}",
                         "output_sha256": designer.digest(target), "size": target.stat().st_size, **measured})
        if any(designer.digest(path) != sha for path, sha in hashes.items()):
            raise ValueError("Configuration, design or processing code changed during this run.")
        designer.verify_evidence(settings)
        for row in rows:
            source = ROOT / "experiment/mixtures" / row["input_path"].removeprefix("data/mixed/")
            if designer.digest(source) != row["input_sha256"]:
                raise ValueError("Mixture changed before publication.")
        record = {"version": 1, "status": "completed", "run_id": run_id,
                  "calculated_at": datetime.now(timezone.utc).isoformat(), "settings": settings,
                  "config_sha256": hashes[designer.CONFIG], "recordings": recordings,
                  "design_manifest": design_path.relative_to(ROOT).as_posix(), "design_manifest_sha256": hashes[design_path],
                  "engine": {"language": "C", "tool_version": "cnr-fixed-prefilter/1", "source_sha256": hashes[CODE],
                             "runner_sha256": hashes[Path(__file__)], "executable_sha256": designer.digest(executable),
                             "processing": "causal_single_pass_df2_transposed_zero_state_per_wav",
                             "quantization": "PCM16_round_half_away_from_zero_no_clipping_no_normalization"},
                  "planned_count": 144, "actual_count": len(rows), "conditions": rows,
                  "evaluation_relationship": settings["evaluation_relationship"]}
        designer.write_json(stage / "manifest.json", record)
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists(): raise FileExistsError("Completed filter runs are preserved.")
        stage.rename(output)
        pointer = ROOT / "experiment/outputs/prefilter_results.json"
        temporary = pointer.with_name(f"prefilter_results.{uuid.uuid4().hex}.tmp")
        try:
            designer.write_json(temporary, {"version": 1, "manifest": (output / "manifest.json").relative_to(ROOT).as_posix(),
                                            "sha256": designer.digest(output / "manifest.json")})
            temporary.replace(pointer)
        finally:
            temporary.unlink(missing_ok=True)
        return {"run_id": run_id, "planned_count": 144, "actual_count": len(rows), "manifest": str(output / "manifest.json")}
    finally:
        if stage.exists():
            if stage.resolve() != stage or stage.parent != cache: raise ValueError("Unsafe cache cleanup path.")
            shutil.rmtree(stage)


if __name__ == "__main__":
    print(json.dumps(generate(), ensure_ascii=False))
