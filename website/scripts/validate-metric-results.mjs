import { normalizeMetrics } from '../shared/research/metrics.js';

export function validateMetricResults(rows, { allowEmpty = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0 && !allowEmpty) throw new Error('계산이 완료된 지표 행 배열이 필요합니다.');
  const normalized = normalizeMetrics(rows);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], metric = normalized[index];
    if (row.sample_id !== metric.sample_id || !['stoi', 'estoi'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))) {
      throw new Error(`${metric.sample_id}: 실제 계산된 STOI와 ESTOI가 모두 필요합니다.`);
    }
    if (!metric.reference_sha256 || !metric.compared_sha256 || !metric.tool_version.trim()) {
      throw new Error(`${metric.sample_id}: 입력 파일 지문과 계산 도구 버전이 필요합니다.`);
    }
    if (!['sample_rate', 'samples'].every(key => Number.isSafeInteger(row[key]) && row[key] > 0) ||
        typeof row.calculated_at !== 'string' || !Number.isFinite(Date.parse(row.calculated_at))) {
      throw new Error(`${metric.sample_id}: 계산 구간과 계산 시각을 확인하세요.`);
    }
  }
  return rows;
}
