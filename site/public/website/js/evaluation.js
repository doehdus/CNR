import { SCORE_LEVELS, requireEvaluationSample, numberOrNull, normalizeManifest, normalizeNoiseSources } from './dataset.js';
import { normalizeMetrics } from './metrics.js';

export const RATING_FIELDS = ['listener_id', 'sample_id', 'understanding', 'noise', 'naturalness', 'key_response', 'grading_version', 'key_correct', 'key_total', 'recorded_at'];
export function ratingKey(row) { return JSON.stringify([row.listener_id, row.sample_id]); }
export function previewRating(fields) {
  const scores = Object.fromEntries(['understanding', 'noise', 'naturalness'].map(key => {
    const value = fields[key] === '' || fields[key] === undefined ? null : Number(fields[key]);
    return [key, SCORE_LEVELS.includes(value) ? value : null];
  }));
  const correct = numberOrNull(fields.key_correct, '정답 수'), total = numberOrNull(fields.key_total, '전체 문항 수');
  const valid = Boolean(String(fields.grading_version || '').trim()) && Number.isInteger(correct) && Number.isInteger(total) && total > 0 && correct >= 0 && correct <= total;
  return { ...scores, key_rate: valid ? correct / total : null };
}
export function normalizeRatings(rows) {
  if (!Array.isArray(rows)) throw new Error('응답 행 배열이 필요합니다.');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('응답 행 형식을 확인하세요.');
    const listener_id = String(row.listener_id ?? '').trim(), sample_id = String(row.sample_id ?? '').trim();
    if (!listener_id || listener_id.length > 64) throw new Error('익명 평가자 ID는 1~64자로 입력하세요.');
    requireEvaluationSample(sample_id);
    const result = { listener_id, sample_id };
    for (const field of ['understanding', 'noise', 'naturalness']) {
      result[field] = numberOrNull(row[field], field);
      if (!SCORE_LEVELS.includes(result[field])) throw new Error('청취 평가의 3항목 모두 0 / 2.5 / 5 / 7.5 / 10 중 하나를 입력하세요.');
    }
    result.key_response = String(row.key_response ?? '');
    if (result.key_response.length > 2000) throw new Error('핵심 정보 원응답은 2,000자 이내로 입력하세요.');
    result.grading_version = String(row.grading_version ?? '').trim();
    if (result.grading_version.length > 80) throw new Error('채점 기준 버전은 80자 이내로 입력하세요.');
    result.key_correct = numberOrNull(row.key_correct, '정답 수'); result.key_total = numberOrNull(row.key_total, '전체 문항 수');
    const hasGrading = result.grading_version || result.key_correct !== null || result.key_total !== null;
    if (hasGrading && (!result.grading_version || !Number.isInteger(result.key_correct) || !Number.isInteger(result.key_total) || result.key_total < 1 || result.key_correct < 0 || result.key_correct > result.key_total)) throw new Error('채점하려면 기준 버전과 올바른 정답 수·전체 문항 수를 모두 입력하세요.');
    result.recorded_at = row.recorded_at ? String(row.recorded_at) : new Date().toISOString();
    if (!Number.isFinite(Date.parse(result.recorded_at))) throw new Error('응답 기록 시각이 올바르지 않습니다.');
    const key = ratingKey(result);
    if (seen.has(key)) throw new Error(`${listener_id}: 같은 음원의 중복 응답이 있습니다.`);
    seen.add(key); return result;
  });
}
export function mergeRatings(current, incoming) {
  const existing = new Set(current.map(ratingKey));
  for (const row of incoming) if (existing.has(ratingKey(row))) throw new Error(`${row.listener_id}: 같은 음원의 응답이 이미 있습니다. 삭제·확인 후 다시 입력하세요.`);
  return [...current, ...incoming];
}
export function aggregateRatings(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.sample_id)) groups.set(row.sample_id, []);
    groups.get(row.sample_id).push(row);
  }
  return [...groups].map(([sample_id, group]) => {
    const average = key => group.reduce((sum, row) => sum + row[key], 0) / group.length;
    const graded = group.filter(row => row.key_total !== null && row.key_correct !== null && row.grading_version);
    const versions = new Set(graded.map(row => row.grading_version));
    const total = graded.reduce((sum, row) => sum + row.key_total, 0);
    return { sample_id, count: group.length, understanding: average('understanding'), noise: average('noise'), naturalness: average('naturalness'), graded_count: graded.length, grading_version: versions.size === 1 ? [...versions][0] : null, grading_mixed: versions.size > 1, key_rate: versions.size === 1 && total > 0 ? graded.reduce((sum, row) => sum + row.key_correct, 0) / total : null };
  });
}

export function normalizeBackup(input) {
  if (!input || input.version !== 1 || !input.paths || typeof input.paths !== 'object' || Array.isArray(input.paths) || !Array.isArray(input.metrics) || !Array.isArray(input.ratings)) throw new Error('version 1의 전체 JSON 백업이 필요합니다.');
  const paths = normalizeManifest({ version: 1, samples: Object.entries(input.paths).map(([id, path]) => ({ id, path })) });
  const noise_paths = normalizeNoiseSources(Object.entries(input.noise_paths || {}).map(([id, path]) => ({ id, path })));
  return { version: 1, paths, noise_paths, metrics: normalizeMetrics(input.metrics), ratings: normalizeRatings(input.ratings) };
}
