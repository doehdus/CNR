"""Run the selected common Butterworth BPF on all 144 mixtures; preserve WAV runs and hashes."""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import csv

from . import design_bpf as designer

ROOT = designer.ROOT
CODE = Path(__file__).with_name("prefilter.c")


selected_design = designer.selected_design


def filter_file(executable, source, target, sections, gain_db=0, measure_only=False):
    command = [str(executable), "--input", str(source)]
    command.extend(['--measure-only'] if measure_only else ['--output',str(target)])
    if gain_db: command.extend(['--gain-db',str(gain_db)])
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
    output = designer.project_path(ROOT / "experiment/outputs/enhanced/prefilter_bpf/runs" / run_id)
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
            unscaled = filter_file(executable, source, None, design['sections'], measure_only=True)
            measured = filter_file(executable, source, target, design["sections"], settings['comparison_gain_db'])
            comparison_target = stage / 'comparison' / suffix
            comparison_target.parent.mkdir(parents=True,exist_ok=True)
            identity = [{'b':[1,0,0], 'a':[1,0,0]}]*2
            comparison = filter_file(executable,source,comparison_target,identity,settings['comparison_gain_db'])
            if comparison['clipped_samples'] != 0: raise ValueError('Comparison input overflowed.')
            if measured["tool_version"] != "cnr-fixed-prefilter/1" or measured["clipped_samples"] != 0:
                raise ValueError("Invalid C filter result.")
            if designer.digest(source) != original_hashes[logical_input]:
                raise ValueError("Mixture changed during filtering.")
            rows.append({"noise": row["noise"], "snr": row["snr"], "statement": row["statement"],
                         "speaker": speakers[row["statement"]], "input_path": logical_input,
                         "input_sha256": original_hashes[logical_input],
                         "comparison_input_path": f"outputs/prefilter_bpf/runs/{run_id}/comparison/{suffix}",
                         "comparison_input_sha256": designer.digest(comparison_target),
                         "unscaled_bpf_peak": unscaled['output_peak'],
                         "unscaled_would_overflow_samples": unscaled['would_overflow_samples'],
                         "output_path": f"outputs/prefilter_bpf/runs/{run_id}/{suffix}",
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
                  "evaluation_relationship": settings["evaluation_relationship"],
                  "selection_summary": [c for c in designer.read_json(ROOT / settings["selection_evidence"][4]["path"])["candidates"]
                                        if (c['lower_hz'] == 75 and c['upper_hz'] == 4000) or
                                           (c['prototype_order'] == 2 and ((c['lower_hz'] in (50,100) and c['upper_hz'] == 4000) or
                                                                          (c['lower_hz'] == 75 and c['upper_hz'] in (3500,4500))))]}
        with (ROOT / settings['selection_evidence'][5]['path']).open(newline='') as stream:
            record['selection_cases'] = [r for r in csv.DictReader(stream)
                                         if r['candidate_id'] == settings['selected_candidate_id'] and
                                            r['case_id'].startswith(('noise_', 'group_'))]
        designer.write_json(stage / "manifest.json", record)
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists(): raise FileExistsError("Completed filter runs are preserved.")
        stage.rename(output)
        pointer = ROOT / "experiment/outputs/bpf_results.json"
        temporary = pointer.with_name(f"bpf_results.{uuid.uuid4().hex}.tmp")
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
