// Standalone 12-recording analysis; legacy evaluation IDs and response versions stay intact.
const noises = ['single', 'complex', 'changing'], snrs = [20, 10, 5, 0];
const ids = ['instruction', 'warning'].flatMap(kind => Array.from({ length: 6 }, (_, i) => kind + String(i + 1).padStart(2, '0')));
const fail = () => { throw new Error('피크 분석 자료의 조건·입력 지문·수치를 확인하세요.'); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function peakArtifactPath(path) {
  if (typeof path !== 'string' || !/^runs\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\/(graphs\/[a-z0-9_]+\.png|details\/[a-z0-9_]+\.json)$/.test(path)) fail();
  return path;
}
export function peakSourcePath(path) {
  if (/^data\/(clean|reference)\/(instruction|warning)0[1-6]\.wav$/.test(path) || /^data\/noise\/(single|complex|changing)\.wav$/.test(path)) return path;
  if (/^data\/mixed\/(single|complex|changing)\/snr(00|05|10|20)\/(instruction|warning)0[1-6]\.wav$/.test(path)) return 'data/mixtures/' + path.slice('data/mixed/'.length);
  fail();
}
export function normalizePeakAnalysis(data) {
  if (data === null) return null;
  if (!data || data.version !== 1 || data.status !== 'exploratory') fail();
  const f = data.frequency_hz;
  if (!Array.isArray(f) || f.length !== 1025 || f.some((v, i) => !finite(v) || v !== i * 16000 / 2048)) fail();
  const vector = values => { if (!Array.isArray(values) || values.length !== f.length || !values.every(finite)) fail(); };
  if (!Array.isArray(data.recordings) || data.recordings.length !== 12 || new Set(data.recordings.map(r => r.id)).size !== 12 || data.recordings.some(r => !ids.includes(r.id) || typeof r.text !== 'string' || typeof r.speaker !== 'string')) fail();
  if (!data.method || data.method.name !== 'Welch PSD' || data.method.sample_rate_hz !== 16000 || data.method.nperseg !== 2048 || data.method.noverlap !== 1024 || data.method.unit !== 'dBFS/Hz' || !finite(data.method.prominence_db) || data.method.prominence_db <= 0) fail();
  if (!Array.isArray(data.files) || data.files.length !== 171 || new Set(data.files.map(r => r.path)).size !== 171) fail();
  for (const file of data.files) if (![peakSourcePath(file.path), file.path.startsWith('data/mixed/') ? 'experiment/mixtures/' + file.path.slice('data/mixed/'.length) : 'experiment/' + file.path].includes(file.source) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 44) fail();
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
    for (const peak of source.peaks) if (!/^p[1-8]$/.test(peak.id) || ![peak.frequency_hz, peak.low_hz, peak.high_hz, peak.magnitude_db, peak.prominence_db, peak.bandwidth_hz, peak.time_change_db].every(finite) || peak.low_hz < 0 || peak.high_hz > 8000 || peak.low_hz >= peak.high_hz || peak.frequency_hz < peak.low_hz || peak.frequency_hz > peak.high_hz || peak.prominence_db + 1e-9 < data.method.prominence_db || peak.bandwidth_hz <= 0) fail();
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
  if (data.engine !== undefined) {
    if (data.engine.language !== 'C' || data.engine.tool_version !== 'cnr-frequency-analysis/1' || !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(data.engine.run_id) ||
      !['source_sha256', 'executable_sha256', 'config_sha256'].every(key => /^[0-9a-f]{64}$/.test(data.engine[key])) || !Number.isFinite(Date.parse(data.engine.calculated_at)) || !data.artifacts || Array.isArray(data.artifacts)) fail();
    for (const [path, hash] of Object.entries(data.artifacts)) {
      peakArtifactPath(path);
      if (!path.startsWith('runs/' + data.engine.run_id + '/') || !/^[0-9a-f]{64}$/.test(hash)) fail();
    }
    const referenced = new Set();
    for (const row of [...data.sources, ...data.conditions]) {
      if (!row.graphs || !['welch', 'peaks', 'temporal'].every(key => row.graphs[key]) || !row.details) fail();
      for (const path of [...Object.values(row.graphs), row.details]) {
        peakArtifactPath(path); if (!data.artifacts[path]) fail(); referenced.add(path);
      }
    }
    if (referenced.size !== Object.keys(data.artifacts).length) fail();
    for (const row of data.conditions) {
      if (!Array.isArray(row.mixture_peaks) || row.mixture_peaks.length > 8) fail();
      for (const peak of row.mixture_peaks) if (!/^p[1-8]$/.test(peak.id) || ![peak.frequency_hz, peak.low_hz, peak.high_hz, peak.bandwidth_hz, peak.prominence_db, peak.magnitude_db].every(finite) || peak.low_hz < 0 || peak.high_hz > 8000 || peak.low_hz >= peak.high_hz || peak.bandwidth_hz <= 0) fail();
      for (const observation of row.observations) if (observation.mixture_width_hz !== null && (!finite(observation.mixture_width_hz) || observation.mixture_width_hz <= 0)) fail();
    }
  }
  return data;
}
export function peakInputsMatch(data, fingerprints) {
  return Boolean(data) && data.files.every(file => fingerprints[file.path] === file.sha256);
}

export function normalizePeakDetails(data, runId) {
  if (!data || data.version !== 1 || data.engine?.language !== 'C' || data.engine?.run_id !== runId || !Number.isSafeInteger(data.sample_count) || data.sample_count < 2048) fail();
  const compact = data.delivery?.format === 'track-summaries';
  if (compact && (data.delivery.version !== 1 || !/^[0-9a-f]{64}$/.test(data.delivery.source_sha256))) fail();
  for (const kind of ['signal', 'speech', 'added_noise']) {
    const signal = data[kind]; if (!signal && kind !== 'signal') continue;
    if (!signal || !Number.isSafeInteger(signal.frame_count) || signal.frame_count < 1 || !Array.isArray(signal.peaks)) fail();
    if (!compact && (!Array.isArray(signal.times_sec) || signal.times_sec.length !== signal.frame_count || !signal.times_sec.every(finite) || !Array.isArray(signal.psd_db) || signal.psd_db.length !== 1025 || !signal.psd_db.every(finite))) fail();
    const tracking = signal.tracking;
    if (!tracking || tracking.frame_count !== signal.frame_count || !Number.isSafeInteger(tracking.interval_frame_count) || tracking.interval_frame_count < 0 || tracking.interval_frame_count > signal.frame_count || !Array.isArray(tracking.tracks)) fail();
    if (compact) tracking.tracks = tracking.tracks.map(row => {
      if (!Array.isArray(row)) return row;
      if (row.length !== 13) fail();
      const [id,count,mean_hz,std_hz,mean_width_hz,appearance_percent,start_sec,end_sec,intervalCount,intervalAppearance,intervalMean,intervalStd,intervalWidth] = row;
      return {id,count,mean_hz,std_hz,mean_width_hz,appearance_percent,start_sec,end_sec,
        interval:{count:intervalCount,appearance_percent:intervalAppearance,mean_hz:intervalMean,std_hz:intervalStd,mean_width_hz:intervalWidth}};
    });
    const trackIds = new Set();
    for (const track of tracking.tracks) {
      if (!Number.isSafeInteger(track.id) || track.id < 1 || trackIds.has(track.id) || !Number.isSafeInteger(track.count) || track.count < 1 || track.count > signal.frame_count || !compact && (!Array.isArray(track.points) || track.points.length !== track.count)) fail();
      trackIds.add(track.id);
      if (![track.mean_hz, track.std_hz, track.mean_width_hz, track.appearance_percent, track.start_sec, track.end_sec].every(finite) || track.mean_hz < 0 || track.mean_hz > 8000 || track.std_hz < 0 || track.mean_width_hz <= 0 || track.appearance_percent < 0 || track.appearance_percent > 100 || track.start_sec < 0 || track.end_sec <= track.start_sec) fail();
      for (const [index, point] of (track.points || []).entries()) if (!Array.isArray(point) || point.length !== 3 || !Number.isSafeInteger(point[0]) || point[0] < 0 || point[0] >= signal.frame_count || index && point[0] !== track.points[index - 1][0] + 1 || !finite(point[1]) || point[1] < 0 || point[1] > 8000 || !finite(point[2]) || point[2] <= 0) fail();
      const interval = track.interval;
      if (!interval || !Number.isSafeInteger(interval.count) || interval.count < 0 || interval.count > track.count || interval.count > tracking.interval_frame_count || !finite(interval.appearance_percent) || interval.appearance_percent < 0 || interval.appearance_percent > 100) fail();
      for (const key of ['mean_hz', 'std_hz', 'mean_width_hz']) if (interval.count ? !finite(interval[key]) : interval[key] !== null) fail();
    }
    if (!Array.isArray(tracking.peak_track_ids) || tracking.peak_track_ids.length !== signal.peaks.length || tracking.peak_track_ids.some(id => id !== null && !trackIds.has(id))) fail();
  }
  return data;
}

// Serialization only: all numerical values are copied from completed C output.
export function peakDetailsForWeb(data, sourceHash, observations = []) {
  const summarize = (signal, keep) => ({
    frame_count:signal.frame_count, peaks:signal.peaks,
    tracking:{method:signal.tracking.method,frame_count:signal.frame_count,interval_frame_count:signal.tracking.interval_frame_count,
      peak_track_ids:signal.tracking.peak_track_ids,tracks:signal.tracking.tracks.filter(track=>!keep || keep.has(track.id)).map(track=>[
        track.id,track.count,track.mean_hz,track.std_hz,track.mean_width_hz,track.appearance_percent,track.start_sec,track.end_sec,
        track.interval.count,track.interval.appearance_percent,track.interval.mean_hz,track.interval.std_hz,track.interval.mean_width_hz])},
  });
  const result={version:1,engine:data.engine,sample_count:data.sample_count,interval_sec:data.interval_sec,
    delivery:{version:1,format:'track-summaries',source_sha256:sourceHash},signal:summarize(data.signal)};
  if(data.added_noise) {
    const ids=new Set([...data.added_noise.tracking.peak_track_ids,...observations.map(row=>row.noise_track_id)]);
    result.added_noise=summarize(data.added_noise,ids);
  }
  return result;
}
