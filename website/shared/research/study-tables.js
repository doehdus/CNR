import { NOISES, SNRS, STATEMENTS, ALL_METHODS, SAMPLE_INDEX, conditionId, matchesFilters } from './dataset.js';

export function conditionRows() {
  return NOISES.flatMap(noise => STATEMENTS.map(statement => ({
    id: `${noise.id}_${statement.id}`, noise, statement,
    cells: SNRS.map(snr => {
      const id = conditionId(noise.id, snr, statement.id);
      return { id, noise: noise.id, statement: statement.id, snr, clean: `clean_${statement.id}`, ...Object.fromEntries(ALL_METHODS.map(method => [method.id, `${id}_${method.id}`])) };
    })
  })));
}

export function listeningCellResults(groups, cell, algorithm = 'all', filters = {}) {
  return ALL_METHODS.filter(method => (algorithm === 'all' || method.id === algorithm) && matchesFilters(SAMPLE_INDEX.get(cell[method.id]), filters))
    .map(method => ({ method, sampleId: cell[method.id], result: groups.get(cell[method.id]) }))
    .filter(row => algorithm !== 'all' || row.result?.count > 0);
}

export function metricMatchesInputs(metric, paths, fingerprints, temporaryIds = new Set()) {
  const sample = SAMPLE_INDEX.get(metric.sample_id);
  if (!sample || sample.kind === 'clean') return false;
  const referenceId = `clean_${sample.statement}`;
  if (temporaryIds.has(sample.id) || temporaryIds.has(referenceId)) return false;
  if (!metric.reference_path) return true;
  return metric.reference_id === referenceId && metric.reference_path === paths[referenceId] &&
    metric.compared_path === paths[sample.id] && fingerprints[metric.reference_path] === metric.reference_sha256 &&
    fingerprints[metric.compared_path] === metric.compared_sha256;
}
