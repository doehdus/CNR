import { peakArtifactPath, peakSourcePath } from './peak-analysis-data.js';

const noises = ['single', 'complex', 'changing'], snrs = [20, 10, 5, 0];
const ids = ['instruction', 'warning'].flatMap(kind => Array.from({ length: 6 }, (_, i) => kind + String(i + 1).padStart(2, '0')));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw Error('평균 분석의 조건·정규화·참여 수·파일 지문을 확인하세요.'); };

export function normalizeMixtureSummary(data) {
  if (data?.delivery !== undefined && !hash(data.delivery.source_sha256)) fail();
  if (!data || data.version !== 1 || data.engine?.language !== 'C' || data.engine.tool_version !== 'cnr-mixture-summary/1' ||
      !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(data.engine.run_id) || !hash(data.source_analysis?.sha256) ||
      !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(data.source_analysis.run_id) || !hash(data.interval_metadata_sha256)) fail();
  for (const key of ['source_sha256', 'summary_source_sha256', 'config_sha256', 'executable_sha256', 'runner_sha256', 'plotter_sha256']) if (!hash(data.engine[key])) fail();
  const method = data.method;
  if (!method || method.normalization !== 'clean_registered_interval_rms_1' || method.internal_pauses !== 'included' ||
      method.weighting !== 'equal_per_recording_linear_power' || method.temporal_origin !== 'recording_start' ||
      method.missing_frames !== 'exclude_and_count' || method.unit !== 'normalized dB/Hz' ||
      method.sample_rate_hz !== 16000 || method.nperseg !== 2048 || method.hop !== 1024 ||
      !['prominence_db', 'minimum_distance_bins', 'matching_minimum_bins', 'matching_width_fraction'].every(key => finite(method[key]) && method[key] > 0)) fail();
  if (!Array.isArray(data.frequency_hz) || data.frequency_hz.length !== 1025 || data.frequency_hz.some((value, i) => value !== i * 16000 / 2048)) fail();
  if (!Array.isArray(data.files) || data.files.length !== 171 || new Set(data.files.map(file => file.path)).size !== 171) fail();
  for (const file of data.files) if (![peakSourcePath(file.path), file.path.startsWith('data/mixed/') ? 'experiment/mixtures/' + file.path.slice('data/mixed/'.length) : 'experiment/' + file.path].includes(file.source) || !hash(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 44) fail();
  const vector = values => { if (!Array.isArray(values) || values.length !== 1025 || !values.every(finite)) fail(); };
  if (!Array.isArray(data.groups) || data.groups.length !== 12 || !data.artifacts || Array.isArray(data.artifacts)) fail();
  const keys = new Set(), references = new Set();
  for (const group of data.groups) {
    const identity = group.noise + '/' + group.snr;
    if (keys.has(identity) || !noises.includes(group.noise) || !snrs.includes(group.snr)) fail();
    keys.add(identity);
    if (!Array.isArray(group.members) || group.members.length !== 12 || new Set(group.members.map(member => member.id)).size !== 12) fail();
    for (const member of group.members) if (!ids.includes(member.id) || !Number.isSafeInteger(member.sample_count) ||
        !Number.isSafeInteger(member.start_sample) || !Number.isSafeInteger(member.end_sample) || member.start_sample < 0 ||
        member.end_sample <= member.start_sample || member.sample_count < member.end_sample ||
        !finite(member.clean_rms) || member.clean_rms <= 0 || !finite(member.normalization_gain) || member.normalization_gain <= 0 ||
        Math.abs(member.clean_rms * member.normalization_gain - 1) > 1e-8 || !finite(member.actual_snr_db) || Math.abs(member.actual_snr_db - group.snr) > .015) fail();
    const frameCounts = group.members.map(member => 1 + Math.floor((member.sample_count - 2048) / 1024));
    const frames = Math.max(...frameCounts);
    if (group.sample_rate_hz !== 16000 || group.nperseg !== 2048 || group.hop !== 1024 ||
        !Array.isArray(group.times_sec) || group.times_sec.length !== frames || group.times_sec.some((v, t) => !finite(v) || Math.abs(v - (t + 1) * .064) > 1e-9) ||
        !Array.isArray(group.participant_counts) || group.participant_counts.length !== frames || group.participant_counts.some((v, t) => v !== frameCounts.filter(count => count > t).length) ||
        group.split_sec !== (group.noise === 'changing' ? 2.5 : 0)) fail();
    for (const key of ['mixture', 'speech', 'added_noise']) {
      const signal = group.signals?.[key];
      if (!signal) fail();
      for (const field of ['mean_db', 'min_db', 'max_db']) vector(signal[field]);
      if (signal.mean_db.some((v, i) => v < signal.min_db[i] - 1e-7 || v > signal.max_db[i] + 1e-7)) fail();
      if (group.split_sec) { vector(signal.before_db); vector(signal.after_db); }
      if (!Array.isArray(signal.peaks) || signal.peaks.length > 8 || !Array.isArray(signal.peak_counts) || signal.peak_counts.length !== signal.peaks.length ||
          signal.peak_counts.some(v => !Number.isInteger(v) || v < 0 || v > 12)) fail();
      for (const [i, peak] of signal.peaks.entries()) if (peak.id !== 'p' + (i + 1) ||
          !['frequency_hz', 'magnitude_db', 'prominence_db', 'bandwidth_hz', 'low_hz', 'high_hz'].every(k => finite(peak[k])) ||
          !data.frequency_hz.includes(peak.frequency_hz) || peak.low_hz < 0 || peak.high_hz > 8000 || peak.low_hz >= peak.high_hz ||
          peak.frequency_hz < peak.low_hz || peak.frequency_hz > peak.high_hz || peak.bandwidth_hz <= 0 || peak.prominence_db < method.prominence_db - 1e-8) fail();
      if (!Array.isArray(signal.noise_comparison) || signal.noise_comparison.length > 8 || !Array.isArray(signal.temporal_peaks) || signal.temporal_peaks.length !== signal.noise_comparison.length) fail();
      for (const [i, row] of signal.noise_comparison.entries()) {
        if (row.peak_id !== 'p' + (i + 1) || !finite(row.frequency_hz) || !finite(row.width_hz) || row.width_hz <= 0 ||
            !Number.isInteger(row.matched_count) || row.matched_count < 0 || row.matched_count > 12 ||
            row.mean_peak_hz !== null && (!finite(row.mean_peak_hz) || row.mean_peak_hz < 0 || row.mean_peak_hz > 8000) || group.split_sec && !finite(row.time_change_db)) fail();
        const temporal = signal.temporal_peaks[i];
        if (temporal.peak_id !== row.peak_id || temporal.frequency_hz !== row.frequency_hz || !Array.isArray(temporal.frames) || temporal.frames.length !== frames) fail();
        for (const [t, point] of temporal.frames.entries()) {
          if (!Array.isArray(point) || point.length !== 4 || !Number.isInteger(point[0]) || point[0] < 0 || point[0] > group.participant_counts[t] ||
              !finite(point[1]) || Math.abs(point[1] - point[0] / group.participant_counts[t] * 100) > 1e-7 ||
              (point[0] ? !finite(point[2]) || !finite(point[3]) || point[2] < 0 || point[3] > 8000 || point[2] > point[3] : point[2] !== null || point[3] !== null)) fail();
        }
      }
    }
    if (!group.graphs || !['welch', 'peaks', 'temporal', ...(group.split_sec ? ['change'] : [])].every(key => group.graphs[key])) fail();
    for (const path of Object.values(group.graphs)) { peakArtifactPath(path); if (!path.startsWith('runs/' + data.engine.run_id + '/graphs/') || !hash(data.artifacts[path])) fail(); references.add(path); }
  }
  if (references.size !== Object.keys(data.artifacts).length) fail();
  return data;
}

export function mixtureSummaryMatches(data, analysis, fingerprints) {
  return Boolean(data && analysis && data.source_analysis.run_id === analysis.engine?.run_id &&
    data.source_analysis.sha256 === analysis.delivery?.source_sha256 && data.engine.config_sha256 === analysis.engine.config_sha256 &&
    data.files.every(file => fingerprints[file.path] === file.sha256));
}

export function normalizeSNRComparison(data, summary, sourceHash = summary.delivery?.source_sha256) {
  if (!data || data.version !== 1 || data.curves !== 'stored_mixture_mean_db_unchanged' ||
      data.source_run_id !== summary.engine.run_id || !hash(data.source_summary_sha256) ||
      sourceHash && data.source_summary_sha256 !== sourceHash || !hash(data.renderer_sha256) ||
      !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(data.render_id) || data.unit !== summary.method.unit ||
      JSON.stringify(data.snrs) !== '[0,5,10,20]' || JSON.stringify(data.x_range_hz) !== '[0,8000]' ||
      !Array.isArray(data.y_range_db) || data.y_range_db.length !== 2 || !data.y_range_db.every(finite) || data.y_range_db[0] >= data.y_range_db[1] ||
      !data.graphs || Object.keys(data.graphs).length !== 3 || !data.artifacts || Object.keys(data.artifacts).length !== 3) fail();
  for (const noise of noises) {
    const path = peakArtifactPath(data.graphs[noise]);
    if (path !== `runs/${data.render_id}/graphs/${noise}_snr_comparison.png` || !hash(data.artifacts[path])) fail();
  }
  for (const group of summary.groups) if (group.signals.mixture.mean_db.some(value => value < data.y_range_db[0] || value > data.y_range_db[1])) fail();
  return data;
}

export function normalizePeakComparison(data, summary, sourceHash = summary.delivery?.source_sha256) {
  if (!data || data.version !== 1 || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(data.render_id) ||
      data.source_run_id !== summary.engine.run_id || !hash(data.source_summary_sha256) || sourceHash && data.source_summary_sha256 !== sourceHash ||
      data.source_analysis_sha256 !== summary.source_analysis.sha256 || JSON.stringify(data.snrs) !== '[0,5,10,20]') fail();
  for (const key of ['renderer_sha256', 'aggregation_source_sha256', 'aggregation_executable_sha256', 'period_analyzer_sha256', 'period_source_sha256', 'period_executable_sha256']) if (!hash(data[key])) fail();
  const expectedMethod = { tracking: 'mean_of_per_recording_longest_matching_trajectory', std_missing: 'exclude_and_report_count', frequency_missing: 'exclude_and_report_count',
    appearance_missing: 'zero_among_12', clean_ratio: 'ratio_of_band_powers_from_stored_normalized_mean_psd', matching: 'original_analysis_rules', psd_averaging: 'none',
    changing_split_sec: 2.5, segment_frames: 'restart_at_exact_segment_start_full_windows_only_no_boundary_crossing' };
  for (const [key, value] of Object.entries(expectedMethod)) if (data.method?.[key] !== value) fail();
  const axisNames = ['detection_percent', 'frequency_offset_hz', 'frequency_std_hz', 'appearance_percent', 'clean_to_noise_db'];
  for (const key of axisNames) if (!Array.isArray(data.axes?.[key]) || data.axes[key].length !== 2 || !data.axes[key].every(finite) || data.axes[key][0] >= data.axes[key][1]) fail();
  if (JSON.stringify(data.axes.detection_percent) !== '[0,105]' || JSON.stringify(data.axes.appearance_percent) !== '[0,105]') fail();
  if (!Array.isArray(data.groups) || data.groups.length !== 20) fail();
  const keys = new Set();
  for (const group of data.groups) {
    const identity = `${group.noise}/${group.snr}/${group.period}`;
    if (keys.has(identity) || !noises.includes(group.noise) || !snrs.includes(group.snr) ||
      !(group.noise === 'changing' ? ['whole', 'before', 'after'] : ['whole']).includes(group.period)) fail();
    keys.add(identity);
    const source = summary.groups.find(g => g.noise === group.noise && g.snr === group.snr);
    if (!Array.isArray(group.members) || group.members.length !== 12 || new Set(group.members.map(m => m.id)).size !== 12 ||
      group.members.some(m => !ids.includes(m.id)) || !Array.isArray(group.peaks) || group.peaks.length !== source.signals.mixture.noise_comparison.length) fail();
    for (const member of group.members) {
      if (!Array.isArray(member.track_ids) || member.track_ids.length !== group.peaks.length || member.track_ids.some(id => id !== null && (!Number.isInteger(id) || id < 1))) fail();
      if (group.period === 'whole') { peakArtifactPath(member.details); if (!hash(data.detail_hashes?.[member.details])) fail(); }
      else if (!hash(data.period_hashes?.[member.period_data]) || !finite(member.normalization_gain) ||
        member.normalization_gain !== source.members.find(m => m.id === member.id).normalization_gain) fail();
    }
    for (const [i, peak] of group.peaks.entries()) {
      const anchor = source.signals.mixture.noise_comparison[i];
      if (peak.peak_id !== anchor.peak_id || peak.frequency_hz !== anchor.frequency_hz || peak.width_hz !== anchor.width_hz ||
        !finite(peak.low_hz) || !finite(peak.high_hz) || peak.low_hz < 0 || peak.high_hz > 8000 || peak.low_hz >= peak.high_hz ||
        peak.frequency_hz < peak.low_hz || peak.frequency_hz > peak.high_hz ||
        !['mixture_count', 'clean_count', 'added_noise_count', 'valid_tracks'].every(key => Number.isInteger(peak[key]) && peak[key] >= 0 && peak[key] <= 12) ||
        peak.valid_tracks !== group.members.filter(m => m.track_ids[i] !== null).length ||
        !finite(peak.mean_appearance_percent) || peak.mean_appearance_percent < 0 || peak.mean_appearance_percent > 100 || !finite(peak.clean_to_noise_db)) fail();
      for (const field of ['mean_frequency_hz', 'mean_offset_hz', 'mean_std_hz']) if (peak.valid_tracks ? !finite(peak[field]) : peak[field] !== null) fail();
      if (!peak.valid_tracks && peak.mean_appearance_percent !== 0 || peak.mean_std_hz !== null && peak.mean_std_hz < 0) fail();
      if (peak.valid_tracks && Math.abs(peak.mean_frequency_hz - peak.frequency_hz - peak.mean_offset_hz) > 1e-7) fail();
      if (group.period === 'whole') for (const [field, signal] of [['mixture_count','mixture'], ['clean_count','speech'], ['added_noise_count','added_noise']]) if (peak[field] !== source.signals[signal].noise_comparison[i].matched_count) fail();
      for (const [field, axis] of [['mean_offset_hz','frequency_offset_hz'], ['mean_std_hz','frequency_std_hz'], ['clean_to_noise_db','clean_to_noise_db']]) if (peak[field] !== null && (peak[field] < data.axes[axis][0] || peak[field] > data.axes[axis][1])) fail();
      for (const field of ['noise_reference_mean_hz', 'noise_reference_offset_hz', 'noise_reference_std_hz', 'noise_reference_appearance_percent']) if (peak[field] !== null && !finite(peak[field])) fail();
    }
  }
  if (!data.graphs || Object.keys(data.graphs).length !== 9 || !data.artifacts || Object.keys(data.artifacts).length !== 9 ||
    !data.period_hashes || Object.keys(data.period_hashes).length !== 4 || !data.detail_hashes || Object.keys(data.detail_hashes).length !== 147) fail();
  for (const noise of noises) for (const kind of ['peaks', 'tracking', 'clean']) {
    const path = peakArtifactPath(data.graphs[`${noise}/${kind}`]);
    if (path !== `runs/${data.render_id}/graphs/${noise}_${kind}_comparison.png` || !hash(data.artifacts[path])) fail();
  }
  for (const [path, value] of Object.entries(data.period_hashes)) if (!new RegExp(`^runs/${data.render_id}/raw/changing_snr(00|05|10|20)_periods\\.json$`).test(path) || !hash(value)) fail();
  for (const [path, value] of Object.entries(data.detail_hashes)) { peakArtifactPath(path); if (!hash(value)) fail(); }
  return data;
}
