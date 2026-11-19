// Standalone 12-recording analysis; legacy evaluation IDs and response versions stay intact.
const noises = ['single', 'complex', 'changing'], snrs = [20, 10, 5, 0];
const ids = ['instruction', 'warning'].flatMap(kind => Array.from({ length: 6 }, (_, i) => kind + String(i + 1).padStart(2, '0')));
const fail = () => { throw new Error('피크 분석 자료의 조건·입력 지문·수치를 확인하세요.'); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function peakSourcePath(path) {
  if (/^data\/(clean|reference)\/(instruction|warning)0[1-6]\.wav$/.test(path) || /^data\/noise\/(single|complex|changing)\.wav$/.test(path)) return 'experiment/' + path;
  if (/^data\/mixed\/(single|complex|changing)\/snr(00|05|10|20)\/(instruction|warning)0[1-6]\.wav$/.test(path)) return 'experiment/mixtures/' + path.slice('data/mixed/'.length);
  fail();
}
export function normalizePeakAnalysis(data) {
  if (data === null) return null;
  if (!data || data.version !== 1 || data.status !== 'exploratory') fail();
  const f = data.frequency_hz;
  if (!Array.isArray(f) || f.length !== 1025 || f.some((v, i) => !finite(v) || v !== i * 16000 / 2048)) fail();
  const vector = values => { if (!Array.isArray(values) || values.length !== f.length || !values.every(finite)) fail(); };
  if (!Array.isArray(data.recordings) || data.recordings.length !== 12 || new Set(data.recordings.map(r => r.id)).size !== 12 || data.recordings.some(r => !ids.includes(r.id) || typeof r.text !== 'string' || typeof r.speaker !== 'string')) fail();
  if (!data.method || data.method.name !== 'Welch PSD' || data.method.sample_rate_hz !== 16000 || data.method.nperseg !== 2048 || data.method.noverlap !== 1024 || data.method.unit !== 'dBFS/Hz' || data.method.prominence_db !== 6) fail();
  if (!Array.isArray(data.files) || data.files.length !== 171 || new Set(data.files.map(r => r.path)).size !== 171) fail();
  for (const file of data.files) if (peakSourcePath(file.path) !== file.source || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 44) fail();
  const files = new Set(data.files.map(file => file.path));
  for (const id of ids) for (const type of ['clean', 'reference']) if (!files.has(`data/${type}/${id}.wav`)) fail();
  if (!Array.isArray(data.sources) || data.sources.length !== 3 || new Set(data.sources.map(r => r.noise)).size !== 3) fail();
  for (const source of data.sources) {
    if (!noises.includes(source.noise) || !files.has(`data/noise/${source.noise}.wav`) || !Array.isArray(source.peaks) || source.peaks.length > 8 || new Set(source.peaks.map(p => p.id)).size !== source.peaks.length) fail();
    vector(source.psd_db);
    // Optional completed summaries are validated before rendering, older exports remain readable.
    if (source.before_psd_db !== undefined || source.after_psd_db !== undefined) {
      vector(source.before_psd_db); vector(source.after_psd_db);
    }
    if (source.band_energy !== undefined) {
      const bands = [[0,100],[100,300],[300,1000],[1000,2000],[2000,4000],[4000,8000]];
      if (!Array.isArray(source.band_energy) || source.band_energy.length !== bands.length || source.band_energy.some((b,i) => b.low_hz !== bands[i][0] || b.high_hz !== bands[i][1] || !finite(b.energy_percent) || b.energy_percent < 0 || b.energy_percent > 100) || Math.abs(source.band_energy.reduce((s,b) => s+b.energy_percent,0)-100) > .01) fail();
    }
    for (const peak of source.peaks) if (!/^p[1-8]$/.test(peak.id) || ![peak.frequency_hz, peak.low_hz, peak.high_hz, peak.magnitude_db, peak.prominence_db, peak.bandwidth_hz, peak.time_change_db].every(finite) || peak.low_hz < 0 || peak.high_hz > 8000 || peak.low_hz >= peak.high_hz || peak.frequency_hz < peak.low_hz || peak.frequency_hz > peak.high_hz || peak.prominence_db < 6 || peak.bandwidth_hz <= 0) fail();
  }
  if (!Array.isArray(data.conditions) || data.conditions.length !== 144) fail();
  const seen = new Set();
  for (const row of data.conditions) {
    const key = `${row.noise}/${row.snr}/${row.statement}`;
    if (seen.has(key) || !noises.includes(row.noise) || !snrs.includes(row.snr) || !ids.includes(row.statement) || !finite(row.actual_snr_db) || Math.abs(row.actual_snr_db - row.snr) > .015 || !files.has(`data/mixed/${row.noise}/snr${String(row.snr).padStart(2, '0')}/${row.statement}.wav`)) fail();
    seen.add(key);
    [row.speech_db, row.noise_db, row.mixture_db].forEach(vector);
    if (!Array.isArray(row.interval_sec) || row.interval_sec.length !== 2 || !row.interval_sec.every(finite) || row.interval_sec[0] < 0 || row.interval_sec[1] <= row.interval_sec[0]) fail();
    const source = data.sources.find(s => s.noise === row.noise);
    if (!Array.isArray(row.observations) || row.observations.length !== source.peaks.length || new Set(row.observations.map(o => o.peak_id)).size !== row.observations.length) fail();
    for (const o of row.observations) if (!source.peaks.some(p => p.id === o.peak_id) || typeof o.speech_peak_present !== 'boolean' || !finite(o.speech_to_noise_db) || o.mixture_frequency_hz !== null && (!finite(o.mixture_frequency_hz) || o.mixture_frequency_hz < 0 || o.mixture_frequency_hz > 8000)) fail();
  }
  return data;
}
export function peakInputsMatch(data, fingerprints) {
  return Boolean(data) && data.files.every(file => fingerprints[file.path] === file.sha256);
}
