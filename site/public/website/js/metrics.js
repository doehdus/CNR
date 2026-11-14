import { requireEvaluationSample, numberOrNull, localPath } from './dataset.js';

export function normalizeMetrics(rows) {
  if (!Array.isArray(rows)) throw new Error('지표 행 배열이 필요합니다.');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('지표 행 형식을 확인하세요.');
    const sample_id = String(row.sample_id ?? '').trim(); requireEvaluationSample(sample_id);
    if (seen.has(sample_id)) throw new Error(`중복 지표 음원: ${sample_id}`);
    seen.add(sample_id);
    const stoi = numberOrNull(row.stoi, 'STOI'), estoi = numberOrNull(row.estoi, 'ESTOI');
    if (stoi === null && estoi === null) throw new Error(`${sample_id}: STOI 또는 ESTOI 실측값이 필요합니다.`);
    for (const value of [stoi, estoi]) if (value !== null && (value < -1 || value > 1)) throw new Error('STOI·ESTOI 값은 -1~1 범위여야 합니다.');
    const result = { sample_id, stoi, estoi, tool_version: String(row.tool_version ?? '').slice(0, 256) };
    const keys = ['reference_id', 'reference_path', 'compared_path', 'reference_sha256', 'compared_sha256'];
    if (keys.some(key => row[key] !== undefined && row[key] !== '')) {
      const sample = requireEvaluationSample(sample_id);
      if (row.reference_id !== `clean_${sample.statement}` || !keys.every(key => typeof row[key] === 'string' && row[key])) throw new Error(`${sample_id}: 기준 음원과 계산 출처를 확인하세요.`);
      for (const key of ['reference_sha256', 'compared_sha256']) if (!/^[a-f0-9]{64}$/.test(row[key])) throw new Error('계산 파일의 SHA-256 정보가 잘못되었습니다.');
      Object.assign(result, Object.fromEntries(keys.map(key => [key, key.endsWith('_path') ? localPath(row[key]) : row[key]])));
    }
    return result;
  });
}
export function metricMap(rows) { return new Map(rows.map(row => [row.sample_id, row])); }
export function mergeMetrics(current, incoming) { return [...new Map([...current, ...incoming].map(row => [row.sample_id, row])).values()]; }
export function improvement(metric, baseline, key) {
  return typeof metric?.[key] === 'number' && typeof baseline?.[key] === 'number' ? metric[key] - baseline[key] : null;
}
