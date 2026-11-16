import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeMetrics } from '../shared/research/metrics.js';

const defaultSiteRoot = fileURLToPath(new URL('../', import.meta.url));

export function validateMetricResults(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('계산이 완료된 지표 행 배열이 필요합니다.');
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

// Only result data crosses this boundary. No Python process, WAV access or DB.
export async function importMetricResults(sourceFile, siteRoot = defaultSiteRoot) {
  const text = (await readFile(sourceFile, 'utf8')).replace(/^\uFEFF/, '');
  const rows = validateMetricResults(JSON.parse(text));
  siteRoot = await realpath(siteRoot);
  let directory = siteRoot;
  for (const segment of ['public', 'metrics', 'results']) {
    directory = path.join(directory, segment);
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error('지표 반영 경로는 이 사이트 안의 실제 폴더여야 합니다.');
  }
  const destination = path.join(directory, 'stoi_estoi.json');
  const temporary = path.join(directory, `.stoi-estoi-${randomUUID()}.tmp`);
  try {
    // Keep every calculation/provenance field, including alignment metadata.
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { count: rows.length, destination };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [flag, sourceFile, ...extra] = process.argv.slice(2);
  try {
    if (flag !== '--source' || !sourceFile || extra.length) throw new Error('Usage: node scripts/import-metric-results.mjs --source <result.json>');
    const result = await importMetricResults(path.resolve(sourceFile));
    console.log(`Imported ${result.count} metric results into ${result.destination}`);
  } catch (error) {
    console.error(`지표 반영 실패: ${error.message}. 먼저 calculate-metrics.cmd를 실행하거나 완료된 결과 JSON을 전달받으세요.`);
    process.exitCode = 1;
  }
}
