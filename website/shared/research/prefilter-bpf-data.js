const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = () => { throw Error('Butterworth BPF 설정·처리 조건·음원 지문을 확인하세요.'); };
export function normalizeBpfPrefilter(data) {
  const s = data?.settings;
  if (data?.version !== 1 || data.status !== 'completed' || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(data.run_id) ||
      data.actual_count !== 144 || data.planned_count !== 144 || !hash(data.config_sha256) || !hash(data.design_manifest_sha256) ||
      s?.version !== 1 || s.status !== 'selected' || s.filter_type !== 'butterworth_bandpass' || s.scope !== 'fixed_common' ||
      s.sample_rate_hz !== 16000 || s.lower_hz !== 75 || s.upper_hz !== 4000 || s.prototype_order !== 2 || s.digital_order !== 4 ||
      s.passband_peak_gain_db !== 0 || s.cutoff_definition !== 'single_pass_power_half_of_passband_peak' ||
      s.comparison_gain_db !== -1 || s.comparison_gain_scope !== 'both_unfiltered_and_bpf_listening_copies' ||
      s.processing !== 'causal_single_pass_df2_transposed_zero_state_per_wav' ||
      !Array.isArray(data.recordings) || data.recordings.length !== 12 || !Array.isArray(data.conditions) || data.conditions.length !== 144 ||
      !Array.isArray(data.selection_summary) || !Array.isArray(data.selection_cases)) fail();
  const recordings = new Map();
  for (const r of data.recordings) {
    if (!/^(instruction|warning)0[1-6]$/.test(r?.id) || recordings.has(r.id) || typeof r.text !== 'string' || !r.text.trim() ||
        typeof r.speaker !== 'string' || !r.speaker.trim()) fail();
    recordings.set(r.id, r);
  }
  const seen = new Set();
  for (const r of data.conditions) {
    const key = `${r.noise}/${r.snr}/${r.statement}`, suffix = `${r.noise}/snr${String(r.snr).padStart(2,'0')}/${r.statement}.wav`;
    if (!['single','complex','changing'].includes(r.noise) || ![20,10,5,0].includes(r.snr) || !recordings.has(r.statement) || seen.has(key) ||
        r.speaker !== recordings.get(r.statement).speaker || r.input_path !== 'data/mixed/' + suffix ||
        r.output_path !== `outputs/prefilter_bpf/runs/${data.run_id}/${suffix}` || !hash(r.input_sha256) || !hash(r.output_sha256) ||
        r.comparison_input_path !== `outputs/prefilter_bpf/runs/${data.run_id}/comparison/${suffix}` || !hash(r.comparison_input_sha256) ||
        !Number.isSafeInteger(r.sample_count) || r.sample_count <= 0 || r.sample_rate_hz !== 16000 ||
        r.size !== 44 + 2*r.sample_count || r.clipped_samples !== 0) fail();
    seen.add(key);
  }
  for (const c of data.selection_summary) {
    if (c.digital_order !== 2*c.prototype_order || ![1,2,3,4].includes(c.prototype_order) || !finite(c.lower_hz) || !finite(c.upper_hz) || c.lower_hz <= 0 || c.lower_hz >= c.upper_hz || c.upper_hz >= 8000 || c.individual_count !== 144) fail();
    for (const field of ['clean_retained_percent','noise_reduction_db','snr_change_db']) {
      if (!['mean','min','max'].every(k=>finite(c[field]?.[k]))) fail();
    }
  }
  if (data.selection_summary.filter(c=>c.id === s.selected_candidate_id).length !== 1) fail();
  const cases=new Set();
  for(const r of data.selection_cases) {
    if(r.candidate_id!==s.selected_candidate_id || cases.has(r.case_id) || !['noise_reduction_db','mixture_reduction_db'].every(k=>r[k]!==''&&Number.isFinite(Number(r[k])))) fail();
    if(r.case_id.startsWith('group_') && !['clean_retained_percent','snr_change_db'].every(k=>r[k]!==''&&Number.isFinite(Number(r[k])))) fail();
    cases.add(r.case_id);
  }
  for(const noise of ['single','complex','changing']) for(const prefix of ['noise_','group_']) {
    if(!cases.has(prefix+noise+(prefix==='group_'?'_snr20_whole':'_whole'))) fail();
  }
  return data;
}
export function bpfPrefilterInputsMatch(data, fingerprints) {
  return Boolean(data && data.conditions.every(r=>fingerprints[r.input_path] === r.input_sha256 && fingerprints[r.output_path] === r.output_sha256 &&
    (fingerprints[r.comparison_input_path] === undefined || fingerprints[r.comparison_input_path] === r.comparison_input_sha256)));
}
