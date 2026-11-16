import { EVALUATION_SAMPLES, NOISES, STATEMENTS, SNRS, algorithmLabel } from './dataset.js';
import { aggregateRatings } from './evaluation.js';
import { metricMap } from './metrics.js';

export function resultRows(metrics, ratings, filters = {}) {
  const scores = metricMap(metrics), groups = new Map(aggregateRatings(ratings).map(group => [group.sample_id, group]));
  return EVALUATION_SAMPLES.filter(sample => ['algorithm', 'noise', 'snr', 'statement'].every(key => !filters[key] || filters[key] === 'all' || String(filters[key]) === String(sample[key]))).map(sample => {
    const metric = scores.get(sample.id), group = groups.get(sample.id);
    const baseline = scores.get(sample.id.slice(0, -sample.algorithm.length) + 'noisy');
    const delta = key => sample.algorithm === 'noisy' || !Number.isFinite(metric?.[key]) || !Number.isFinite(baseline?.[key]) ? null : metric[key] - baseline[key];
    return {
      sample_id: sample.id, algorithm: algorithmLabel(sample.algorithm), noise: NOISES.find(noise => noise.id === sample.noise).label,
      statement: STATEMENTS.find(statement => statement.id === sample.statement).label, snr: sample.snr,
      stoi: metric?.stoi ?? null, estoi: metric?.estoi ?? null, delta_stoi: delta('stoi'), delta_estoi: delta('estoi'),
      responses: group?.count || 0, noise_score: group?.noise ?? null, naturalness: group?.naturalness ?? null,
      key_rate: group?.key_rate ?? null, graded_responses: group?.graded_count || 0, grading_version: group?.grading_version || '', grading_mixed: group?.grading_mixed || false
    };
  });
}

export function snrSummary(metrics, algorithm, key) {
  const rows = resultRows(metrics, [], { algorithm });
  return SNRS.map(snr => {
    const valid = rows.filter(row => row.snr === snr && Number.isFinite(row[key]));
    return { snr, count: valid.length, mean: valid.length ? valid.reduce((sum, row) => sum + row[key], 0) / valid.length : null };
  });
}

export function objectiveComparison(metrics, algorithm, filters = {}) {
  const rows = resultRows(metrics, [], { ...filters, algorithm });
  return Object.fromEntries(['stoi', 'estoi'].map(key => [key,
    [...SNRS].sort((a, b) => a - b).map(snr => {
      const matched = rows.filter(row => row.snr === snr && Number.isFinite(row[key]) && Number.isFinite(row['delta_' + key]));
      const average = field => matched.length ? matched.reduce((sum, row) => sum + field(row), 0) / matched.length : null;
      return {
        snr, count: matched.length,
        baseline: average(row => row[key] - row['delta_' + key]),
        processed: average(row => row[key]),
        delta: average(row => row['delta_' + key]),
      };
    }),
  ]));
}

export const REPORT_FIELDS = ['sample_id', 'algorithm', 'noise', 'statement', 'snr', 'stoi', 'estoi', 'delta_stoi', 'delta_estoi', 'responses', 'key_rate', 'noise_score', 'naturalness', 'graded_responses', 'grading_version', 'grading_mixed'];
