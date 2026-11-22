const noises = ['single', 'complex', 'changing'];
const snrs = [20, 10, 5, 0];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = () => { throw Error('고정 EQ 설정·처리 조건·음원 지문을 확인하세요.'); };

export function normalizeFixedPrefilter(data) {
  const settings = data?.settings;
  if (data?.version !== 1 || data.status !== 'completed' || !/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(data.run_id) ||
      data.actual_count !== 144 || data.planned_count !== 144 || !hash(data.config_sha256) ||
      settings?.version !== 1 || settings.filter_type !== 'peaking_eq' || settings.scope !== 'fixed_common' ||
      settings.connection !== 'cascade' || settings.sample_rate_hz !== 16000 || settings.bandwidth_definition !== 'half_gain_db' ||
      !Array.isArray(settings.sections) || settings.sections.length !== 2 ||
      !Array.isArray(data.recordings) || data.recordings.length !== 12 || !Array.isArray(data.conditions) || data.conditions.length !== 144) fail();
  for (const [index, section] of settings.sections.entries()) {
    if (section.id !== `eq${index + 1}` || section.order !== 2 || !['center_hz', 'bandwidth_hz', 'q', 'gain_db'].every(key => finite(section[key])) ||
        section.center_hz <= 0 || section.center_hz >= 8000 || section.bandwidth_hz <= 0 || section.bandwidth_hz >= 8000 || section.q <= 0 || section.gain_db >= 0) fail();
  }
  if (settings.sections[0].center_hz === settings.sections[1].center_hz) fail();
  const recordings = new Map();
  for (const row of data.recordings) {
    if (!/^(instruction|warning)0[1-6]$/.test(row?.id) || recordings.has(row.id) || typeof row.text !== 'string' || !row.text.trim() ||
        typeof row.speaker !== 'string' || !row.speaker.trim()) fail();
    recordings.set(row.id, row);
  }
  const seen = new Set();
  for (const row of data.conditions) {
    const key = `${row.noise}/${row.snr}/${row.statement}`;
    const suffix = `${row.noise}/snr${String(row.snr).padStart(2, '0')}/${row.statement}.wav`;
    if (!noises.includes(row.noise) || !snrs.includes(row.snr) || !recordings.has(row.statement) || seen.has(key) ||
        row.speaker !== recordings.get(row.statement).speaker || row.input_path !== 'data/mixed/' + suffix ||
        row.output_path !== `outputs/prefilter_fixed/runs/${data.run_id}/${suffix}` || !hash(row.input_sha256) || !hash(row.output_sha256) ||
        !Number.isSafeInteger(row.sample_count) || row.sample_count <= 0 || row.sample_rate_hz !== 16000 ||
        row.size !== 44 + 2 * row.sample_count || row.clipped_samples !== 0) fail();
    seen.add(key);
  }
  return data;
}

export function fixedPrefilterInputsMatch(data, fingerprints) {
  return Boolean(data && data.conditions.every(row => fingerprints[row.input_path] === row.input_sha256 && fingerprints[row.output_path] === row.output_sha256));
}
