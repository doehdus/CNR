// Initial design settings only. No audio filtering or performance claim is made here.
const noises = ['single', 'complex', 'changing'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = () => { throw new Error('초기 EQ 설정의 형식·분석 회차·수치를 확인하세요.'); };

export function normalizePrefilterInitial(data) {
  if (data == null) return null;
  if (data.version !== 1 || data.status !== 'initial' || data.filter_type !== 'peaking_eq' ||
      data.scope !== 'fixed_per_noise' || data.bandwidth_definition !== 'half_gain_db' || data.sample_rate_hz !== 16000 ||
      !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(data.analysis_run_id) ||
      !/^[a-f0-9]{64}$/.test(data.analysis_source_sha256) || !Array.isArray(data.presets) || data.presets.length !== 3 ||
      new Set(data.presets.map(preset => preset.noise)).size !== 3) fail();
  for (const preset of data.presets) {
    if (!noises.includes(preset.noise) || !/^p[1-8]$/.test(preset.source_peak_id) ||
        !['center_hz', 'measured_width_hz', 'bandwidth_hz', 'q', 'gain_db'].every(key => finite(preset[key])) ||
        preset.center_hz <= 0 || preset.center_hz >= data.sample_rate_hz / 2 || preset.measured_width_hz <= 0 ||
        preset.bandwidth_hz <= 0 || preset.bandwidth_hz >= data.sample_rate_hz / 2 || preset.q <= 0 || preset.gain_db >= 0) fail();
    const q = Math.sin(2 * Math.PI * preset.center_hz / data.sample_rate_hz) /
      (2 * Math.tan(Math.PI * preset.bandwidth_hz / data.sample_rate_hz));
    if (Math.abs(q - preset.q) > 1e-7) fail();
  }
  return data;
}

export function prefilterMatchesAnalysis(settings, analysis, sourceHash = analysis?.delivery?.source_sha256) {
  return Boolean(settings && analysis?.engine && settings.analysis_run_id === analysis.engine.run_id &&
    settings.analysis_source_sha256 === sourceHash && settings.sample_rate_hz === analysis.method.sample_rate_hz &&
    settings.presets.every(preset => {
      const peak = analysis.sources.find(source => source.noise === preset.noise)?.peaks.find(value => value.id === preset.source_peak_id);
      return peak && Math.abs(peak.frequency_hz - preset.center_hz) < 1e-7 &&
        Math.abs(peak.bandwidth_hz - preset.measured_width_hz) < 1e-7;
    }));
}
