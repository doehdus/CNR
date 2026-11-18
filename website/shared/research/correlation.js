import { SAMPLE_INDEX, matchesFilters } from './dataset.js';
import { aggregateRatings } from './evaluation.js';
import { metricMap } from './metrics.js';

export function averageRanks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) ranks[sorted[i].index] = rank;
    start = end;
  }
  return ranks;
}
export function spearman(x, y) {
  if (x.length !== y.length || x.some(value => !Number.isFinite(value)) || y.some(value => !Number.isFinite(value))) throw new Error('상관분석의 대응 자료를 확인하세요.');
  if (x.length < 2) return { rho: null, n: x.length, reason: '대응 음원 2개 이상 필요' };
  const rx = averageRanks(x), ry = averageRanks(y);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length, my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let covariance = 0, vx = 0, vy = 0;
  for (let i = 0; i < rx.length; i++) { const dx = rx[i] - mx, dy = ry[i] - my; covariance += dx * dy; vx += dx * dx; vy += dy * dy; }
  if (!vx || !vy) return { rho: null, n: x.length, reason: '점수 변동 없음' };
  return { rho: Math.max(-1, Math.min(1, covariance / Math.sqrt(vx * vy))), n: x.length, reason: null };
}
export function pairedSamples(metrics, ratings, filters = {}) {
  const scores = metricMap(metrics);
  const selectedRatings = filters.grading_version && filters.grading_version !== 'all'
    ? ratings.filter(rating => rating.grading_version === filters.grading_version) : ratings;
  return aggregateRatings(selectedRatings).filter(group => {
    const sample = SAMPLE_INDEX.get(group.sample_id);
    return sample && matchesFilters(sample, filters);
  }).map(group => ({ ...group, stoi: scores.get(group.sample_id)?.stoi ?? null, estoi: scores.get(group.sample_id)?.estoi ?? null }));
}
export function correlationResults(pairs, measure = 'key_rate') {
  if (!['noise', 'naturalness', 'key_rate'].includes(measure)) throw new Error('비교할 청음 평가 항목을 확인하세요.');
  return Object.fromEntries(['stoi', 'estoi'].map(key => {
    const valid = pairs.filter(pair => Number.isFinite(pair[key]) && Number.isFinite(pair[measure]));
    const versions = new Set(valid.map(pair => pair.grading_version));
    if (measure === 'key_rate' && versions.size > 1) return [key, { rho: null, n: valid.length, reason: '같은 채점 기준 버전을 선택하세요' }];
    return [key, spearman(valid.map(pair => pair[key]), valid.map(pair => pair[measure]))];
  }));
}
