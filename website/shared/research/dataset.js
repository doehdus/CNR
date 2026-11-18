export const STATEMENTS = Object.freeze([
  { id: 'instruction_01', label: '작업 지시 1', text: '기사님, 장비를 뒤로 2미터 이동해 주세요.', speaker: '유채원' },
  { id: 'instruction_02', label: '작업 지시 2', text: '각재 3개를 오른쪽 적재장으로 옮겨 주세요.', speaker: '유채원' },
  { id: 'warning_01', label: '위험 경고 1', text: '정지! 장비 뒤에 사람 있습니다!', speaker: '김도연' }
]);
export const NOISES = Object.freeze([
  { id: 'single', label: '단일 소음', short: 'SINGLE' },
  { id: 'complex', label: '복합 소음', short: 'COMPLEX' },
  { id: 'changing', label: '변화 소음', short: 'CHANGING' }
]);
export const SNRS = Object.freeze([20, 10, 5, 0]);
export const NOISE_SOURCES = Object.freeze(NOISES.map(noise => ({ id: `noise_${noise.id}`, kind: 'noise', noise: noise.id, label: noise.label, path: `data/noise/${noise.id}.wav` })));
export const PROCESSORS = Object.freeze([
  { id: 'ss_fixed', canonical_id: 'initial_fixed_ss', label: '초기 고정형 SS', family: 'SS' },
  { id: 'ss_pattern_fixed', canonical_id: 'pattern_fixed_ss', label: '패턴 고정형 SS', family: 'SS' },
  { id: 'ss_pattern_update', canonical_id: 'pattern_adaptive_ss', label: '패턴 적응형 SS', family: 'SS' },
  { id: 'wiener', canonical_id: 'wiener', label: 'Wiener', family: 'Wiener' },
  { id: 'logmmse', canonical_id: 'logmmse', label: 'Log-MMSE', family: 'Log-MMSE' },
]);
export const ALGORITHMS = Object.freeze([false, true].flatMap(prefilter => PROCESSORS.map(processor => ({
  id: processor.id + (prefilter ? '_prefilter' : ''), processor: processor.id, prefilter,
  short_label: processor.label, label: processor.label + ' · 전처리 ' + (prefilter ? '적용' : '미적용'), enabled: true,
}))));
export const LEGACY_METHODS = Object.freeze([{ id: 'additional', processor: 'additional', prefilter: false, label: '이전 실험 · 추가 알고리즘', short_label: '기존 추가 알고리즘', legacy: true }]);
export const EVALUATION_METHODS = Object.freeze([
  { id: 'noisy', label: '무처리', processor: null, prefilter: false },
  { id: 'prefilter_only', label: '전처리만', processor: null, prefilter: true },
  ...ALGORITHMS,
]);
export const ALL_METHODS = Object.freeze([...EVALUATION_METHODS, ...LEGACY_METHODS]);
export const algorithmLabel = id => ALL_METHODS.find(method => method.id === id)?.label || id;
export function methodsForPrefilter(prefilter) { return ALGORITHMS.filter(method => method.prefilter === prefilter); }
export function processingMethod(processor, prefilter) {
  const method = ALGORITHMS.find(method => method.processor === processor && method.prefilter === prefilter);
  if (!method) throw new Error('처리 방식과 전처리 조건을 확인하세요.');
  return method;
}
export function matchesFilters(sample, filters = {}) {
  if (!['algorithm', 'noise', 'snr', 'statement', 'processor'].every(key => !filters[key] || filters[key] === 'all' || String(filters[key]) === String(sample[key]))) return false;
  if (filters.prefilter === 'on' || filters.prefilter === true) return sample.prefilter === true;
  if (filters.prefilter === 'off' || filters.prefilter === false) return sample.prefilter === false;
  return !filters.prefilter || filters.prefilter === 'all';
}
export const SCORE_LEVELS = Object.freeze([0, 2.5, 5, 7.5, 10]);

export function conditionId(noise, snr, statement) {
  return `${noise}_snr${String(snr).padStart(2, '0')}_${statement}`;
}
export function createSamples() {
  const samples = STATEMENTS.map(statement => ({ id: `clean_${statement.id}`, kind: 'clean', statement: statement.id, speaker: statement.speaker, noise: null, snr: null, algorithm: 'clean', path: `data/clean/${statement.id}.wav` }));
  for (const noise of NOISES) for (const snr of SNRS) for (const statement of STATEMENTS) {
    const condition = conditionId(noise.id, snr, statement.id);
    const suffix = `${noise.id}/snr${String(snr).padStart(2, '0')}/${statement.id}.wav`;
    for (const method of ALL_METHODS) samples.push({ id: `${condition}_${method.id}`, kind: method.id === 'noisy' ? 'noisy' : 'processed', statement: statement.id, speaker: statement.speaker, noise: noise.id, snr, algorithm: method.id, processor: method.processor, prefilter: method.prefilter, legacy: Boolean(method.legacy), path: method.id === 'noisy' ? `data/mixed/${suffix}` : `outputs/${method.id}/${suffix}` });
  }
  return samples;
}
export const SAMPLES = Object.freeze(createSamples());
export const SAMPLE_INDEX = new Map(SAMPLES.map(sample => [sample.id, sample]));
export const EVALUATION_SAMPLES = Object.freeze(SAMPLES.filter(sample => sample.kind !== 'clean'));
export const CURRENT_EVALUATION_SAMPLES = Object.freeze(EVALUATION_SAMPLES.filter(sample => !sample.legacy));

export function requireEvaluationSample(id) {
  const sample = SAMPLE_INDEX.get(id);
  if (!sample || sample.kind === 'clean') throw new Error(`평가 음원 ID를 확인하세요: ${String(id).slice(0, 100)}`);
  return sample;
}
export function numberOrNull(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}: 숫자를 입력하세요.`);
  const result = Number(value);
  if (!Number.isFinite(result) || (typeof value === 'string' && !value.trim())) throw new Error(`${label}: 유효한 숫자를 입력하세요.`);
  return result;
}
export function localPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('음원 경로가 비어 있습니다.');
  const path = value.trim().replaceAll('\\', '/');
  if (path.startsWith('/') || /[:?#%\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('프로젝트 안의 상대 경로만 사용할 수 있습니다.');
  if (!/^(data|outputs)\/.+\.wav$/i.test(path)) throw new Error('data/ 또는 outputs/ 안의 WAV 경로를 입력하세요.');
  return path;
}
export function normalizeManifest(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.samples)) throw new Error('version: 1과 samples 배열이 있는 경로 JSON이 필요합니다.');
  const paths = {};
  for (const entry of input.samples) {
    if (!entry || !SAMPLE_INDEX.has(entry.id) || Object.hasOwn(paths, entry.id)) throw new Error('경로 설정에 알 수 없거나 중복된 음원 ID가 있습니다.');
    const base = SAMPLE_INDEX.get(entry.id);
    for (const key of ['kind', 'statement', 'speaker', 'noise', 'snr', 'algorithm', 'prefilter', 'processor']) if (entry[key] !== undefined && entry[key] !== base[key]) throw new Error(`${entry.id}: 선정된 문장·녹음자·조건과 일치하지 않습니다.`);
    paths[entry.id] = localPath(entry.path);
  }
  return paths;
}

export function parseCSV(text) {
  const input = String(text).replace(/^\uFEFF/, '');
  if (!input.trim()) return [];
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const finishField = () => { row.push(field); field = ''; closed = false; };
  const finishRow = () => { finishField(); if (row.some(value => value.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error('CSV 따옴표 형식이 잘못되었습니다.');
      quoted = true;
    } else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && input[i + 1] === '\n') i++; finishRow(); }
    else if (closed && char.trim()) throw new Error('CSV 따옴표 뒤의 구분자를 확인하세요.');
    else if (!closed) field += char;
  }
  if (quoted) throw new Error('CSV의 닫히지 않은 따옴표를 확인하세요.');
  if (field || row.length || closed) finishRow();
  if (!rows.length) return [];
  const headers = rows.shift().map(header => header.trim());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new Error('CSV 열 이름이 비어 있거나 중복되었습니다.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV ${index + 2}행의 열 개수를 확인하세요.`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

export function normalizeNoiseSources(rows) {
  if (!Array.isArray(rows)) throw new Error('noise_sources 배열이 필요합니다.');
  const paths = {};
  for (const row of rows) {
    if (!row || !NOISE_SOURCES.some(source => source.id === row.id) || Object.hasOwn(paths, row.id)) throw new Error('소음 원본 ID가 잘못되었거나 중복되었습니다.');
    paths[row.id] = localPath(row.path);
  }
  return paths;
}
export function parseRecords(text, filename, key) {
  if (filename.toLowerCase().endsWith('.csv')) return parseCSV(text);
  let input;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 형식을 확인하세요.'); }
  const rows = Array.isArray(input) ? input : input?.[key];
  if (!Array.isArray(rows)) throw new Error(`${key} 배열 또는 행 배열이 필요합니다.`);
  return rows;
}
export function csvText(rows, fields) {
  const quote = value => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return '\uFEFF' + [fields.join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n') + '\r\n';
}
