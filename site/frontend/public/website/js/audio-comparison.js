import { STATEMENTS, NOISES, NOISE_SOURCES, SNRS, ALGORITHMS, EVALUATION_METHODS, algorithmLabel, SAMPLES, SAMPLE_INDEX, STORAGE_KEY, SCORE_LEVELS, conditionId, normalizeManifest, normalizeNoiseSources, parseRecords, csvText } from './dataset.js';
import { normalizeMetrics, mergeMetrics, metricMap, improvement } from './metrics.js';
import { RATING_FIELDS, previewRating, normalizeRatings, mergeRatings, aggregateRatings, ratingKey, normalizeBackup } from './evaluation.js';
import { RATING_SCALES } from './survey-common.js';
import { pairedSamples, correlationResults } from './correlation.js';
import { conditionRows, metricMatchesInputs, listeningCellResults } from './study-tables.js';
import { resultRows, snrSummary, objectiveComparison, REPORT_FIELDS } from './report.js';
import { renderMetricTrend } from './graphs.js';
import { download, readServerJSON } from './files.js';

const $ = selector => document.querySelector(selector);
const node = (tag, className = '', text = '') => { const result = document.createElement(tag); result.className = className; result.textContent = text; return result; };
const option = (value, label) => { const result = new Option(label, value); return result; };
const format = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const condition = { noise: 'single', snr: 20, statement: 'instruction_01', algorithm: 'ss_fixed' };
let revision = 0, storageReady = false, saving = false;
let surveyResponses = [];
let qrSessions = [], qrListRevision = 0, qrListReady = false;
let refreshingResults = false;
let state = { version: 1, paths: {}, noise_paths: {}, metrics: [], ratings: [] }, serverPaths = {}, serverNoisePaths = {}, serverMetrics = [], availablePaths = new Set(), inputFingerprints = {}, scanError = '', selectedObjective = 'stoi', storageError = '', noticeTimer;

function notify(message, error = false) {
  const target = $('#notice'); target.textContent = message; target.classList.toggle('error', error); target.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { target.hidden = true; }, error ? 15000 : 7000);
}
async function persist(next) {
  if (!storageReady) throw new Error('서버 연결을 확인한 뒤 다시 저장하세요.');
  if (saving) throw new Error('이전 저장이 진행 중입니다. 잠시 후 다시 시도하세요.');
  saving = true;
  try {
    const response = await fetch('/api/study', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, state: next }) });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 409 && payload.state) { state = normalizeBackup(payload.state); revision = payload.revision; setSurveyRatings(payload.survey_ratings); renderAll(); }
      throw new Error(payload.error || '서버에 저장하지 못했습니다.');
    }
    state = normalizeBackup(payload.state); revision = payload.revision; storageError = '';
  } finally { saving = false; }
}
async function readCloudState() {
  const response = await fetch('/api/study', { cache: 'no-store' });
  if (!response.ok) throw new Error('서버의 연구 자료를 읽지 못했습니다. 새로고침하거나 잠시 후 다시 시도하세요.');
  const payload = await response.json();
  if (saving || storageReady && payload.revision < revision) return false;
  const surveyChanged = setSurveyRatings(payload.survey_ratings);
  const changed = !storageReady || payload.revision !== revision || surveyChanged;
  if (changed) { state = normalizeBackup(payload.state); revision = payload.revision; }
  storageReady = true; storageError = '';
  return changed;
}
function setSurveyRatings(rows = []) {
  const next = normalizeRatings(rows).map((row, index) => ({
    ...row, survey_response_id: rows[index].survey_response_id, survey_session_code: rows[index].survey_session_code,
  }));
  const changed = JSON.stringify(next) !== JSON.stringify(surveyResponses);
  surveyResponses = next;
  return changed;
}
function allRatings() {
  return [...new Map([...state.ratings, ...surveyResponses].map(row => [ratingKey(row), row])).values()];
}
function allMetrics() {
  const paths = Object.fromEntries(SAMPLES.map(sample => [sample.id, pathFor(sample)]));
  return mergeMetrics(state.metrics, serverMetrics).filter(metric => metricMatchesInputs(metric, paths, inputFingerprints));
}
function pathFor(sample) { return sample.kind === 'noise' ? state.noise_paths[sample.id] || serverNoisePaths[sample.id] || sample.path : state.paths[sample.id] || serverPaths[sample.id] || sample.path; }
function isConnected(sample) { return availablePaths.has(pathFor(sample)); }
function audioURL(sample) {
  const path = pathFor(sample), url = new URL('../' + path, location.href);
  if (inputFingerprints[path]) url.searchParams.set('v', inputFingerprints[path]);
  return url.href;
}
function currentSamples() {
  const id = conditionId(condition.noise, condition.snr, condition.statement);
  return [SAMPLE_INDEX.get(`clean_${condition.statement}`), SAMPLE_INDEX.get(`${id}_noisy`), SAMPLE_INDEX.get(`${id}_${condition.algorithm}`)];
}
function currentStatement() { return STATEMENTS.find(statement => statement.id === condition.statement); }
function conditionLabel() { return `${NOISES.find(noise => noise.id === condition.noise).label} · ${condition.snr} dB · ${currentStatement().label} · ${currentStatement().speaker}`; }
function stopAudio(except) { document.querySelectorAll('audio').forEach(audio => { if (audio !== except) audio.pause(); }); }

function initializeControls() {
  $('#noise-options').innerHTML = NOISES.map((noise, index) => '<label class="noise-option"><input type="radio" name="noise" value="' + noise.id + '" ' + (index === 0 ? 'checked' : '') + '><span>' + noise.label + '</span><small>' + noise.short + '</small></label>').join('');
  $('#snr-options').innerHTML = SNRS.map((snr, index) => '<label><input type="radio" name="snr" value="' + snr + '" ' + (index === 0 ? 'checked' : '') + '>' + snr + '</label>').join('');
  $('#statement-options').innerHTML = STATEMENTS.map((statement, index) => '<label class="statement-option"><input type="radio" name="statement" value="' + statement.id + '" ' + (index === 0 ? 'checked' : '') + '><span><strong>' + statement.label + '</strong><small>' + statement.speaker + '</small></span></label>').join('');
  for (const algorithm of ALGORITHMS) {
    $('#algorithm').add(option(algorithm.id, algorithm.label));
    $('#graph-algorithm').add(option(algorithm.id, algorithm.label));
    const button = node('button', '', algorithm.label); button.type = 'button'; button.dataset.algorithm = algorithm.id;
    button.addEventListener('click', () => { condition.algorithm = algorithm.id; $('#algorithm').value = algorithm.id; renderAll(); });
    $('#algorithm-tabs').append(button);
  }
  for (const id of ['objective-algorithm', 'analysis-algorithm']) document.getElementById(id).add(option('all', '전체 처리 방식'));
  for (const method of EVALUATION_METHODS) for (const id of ['objective-algorithm', 'analysis-algorithm', 'rating-table-algorithm', 'chart-algorithm']) document.getElementById(id).add(option(method.id, method.label));
  $('#rating-table-algorithm').insertBefore(option('all', '응답이 있는 전체 방식'), $('#rating-table-algorithm').firstChild);
  $('#rating-table-algorithm').value = 'all'; $('#chart-algorithm').value = 'ss_fixed';
  $('#objective-noise').add(option('all', '전체 소음')); $('#objective-snr').add(option('all', '전체 SNR'));
  NOISES.forEach(noise => { for (const selector of ['#analysis-filters [name=noise]', '#listening-condition [name=noise]', '#objective-noise', '#graph-filters [name=noise]']) $(selector).add(option(noise.id, noise.label)); });
  SNRS.forEach(snr => { for (const selector of ['#analysis-filters [name=snr]', '#listening-condition [name=snr]', '#objective-snr']) $(selector).add(option(String(snr), snr + ' dB')); });
  STATEMENTS.forEach(statement => {
    $('#listening-condition [name=statement]').add(option(statement.id, statement.label));
    $('#graph-filters [name=statement]').add(option(statement.id, statement.label));
    $('#analysis-filters [name=statement]').add(option(statement.id, statement.label));
  });
  $('#rating-scales').innerHTML = RATING_SCALES.map(({ name, label, levels }) => '<fieldset class="rating-scale"><legend>' + label + '</legend><div class="scale-options">' + SCORE_LEVELS.map((value, index) => '<label title="' + levels[index] + '"><input type="radio" name="' + name + '" value="' + value + '" required>' + value + '</label>').join('') + '</div><div class="scale-hint"><span>' + levels[0] + '</span><span>' + levels.at(-1) + '</span></div></fieldset>').join('');
}
function statCard(label, value, total, caption, index = '') {
  const card = node('div', 'stat-card'), labelNode = node('div', 'stat-label', label); labelNode.append(node('span', 'stat-index', index));
  const number = node('div', 'stat-value', String(value)); if (total) number.append(node('span', '', `/ ${total}`));
  card.append(labelNode, number, node('div', 'stat-caption', caption)); return card;
}
function renderStats() {
  const count = kind => SAMPLES.filter(sample => sample.kind === kind && isConnected(sample)).length;
  $('#stats').replaceChildren(statCard('깨끗한 음원', count('clean'), 3, '유채원 지시 2 · 김도연 경고 1', 'REFERENCE'), statCard('무처리 합성 음원', count('noisy'), 36, '소음 3종 × SNR 4단계 × 3문장', 'INPUT'), statCard('처리 결과물', count('processed'), 144, 'SS 3종 + 추가 알고리즘 1종', 'OUTPUT'), statCard('저장된 청음 응답', allRatings().length, '', '정답률 + 5단계 평가', 'LISTENING'));
}
function renderComparison() {
  stopAudio();
  const statement = currentStatement(), samples = currentSamples();
  $('#selected-text').textContent = `“${statement.text}”`;
  $('#selected-tags').replaceChildren(...[statement.speaker, NOISES.find(noise => noise.id === condition.noise).label, `SNR ${condition.snr} dB`, statement.label].map(text => node('span', 'tag', text)));
  const labels = ['깨끗한 기준 음성', '무처리 · 소음 혼합 입력', algorithmLabel(condition.algorithm) + ' · 처리 결과'];
  $('#demo-matrix-title').textContent = algorithmLabel(condition.algorithm) + ' 결과물';
  $('#demo-output-count').textContent = SAMPLES.filter(sample => sample.algorithm === condition.algorithm && isConnected(sample)).length + ' / 36 연결';
  document.querySelectorAll('[data-algorithm]').forEach(button => { const active = button.dataset.algorithm === condition.algorithm; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('#players').replaceChildren(...samples.map((sample, index) => {
    const card = node('article', `player-card${index === 2 ? ' processed' : ''}`);
    card.dataset.sampleId = sample.id;
    const title = node('div', 'player-title'); title.append(node('span', 'player-number', `0${index + 1}`), node('span', '', labels[index]), node('span', 'player-status', isConnected(sample) ? '연결됨' : '파일 연결 전'));
    const body = node('div', 'player-body');
    if (isConnected(sample)) {
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', labels[index]); audio.src = audioURL(sample);
      audio.addEventListener('play', () => stopAudio(audio));
      audio.addEventListener('error', () => { body.replaceChildren(node('div', 'empty-audio', '음원을 재생할 수 없습니다. WAV 형식과 파일 경로를 확인하세요.')); }); body.append(audio);
    } else {
      const empty = node('div', 'empty-audio'); empty.append(node('span', 'empty-play', '▶'), node('span', 'empty-track'), node('span', '', '연결 대기')); body.append(empty);
    }
    card.append(title, body, node('div', 'player-path', pathFor(sample))); return card;
  }));
  const scores = metricMap(allMetrics()), baseline = scores.get(samples[1].id), processed = scores.get(samples[2].id);
  const table = node('table', 'metric-table'); table.innerHTML = '<thead><tr><th>지표</th><th>무처리</th><th>' + algorithmLabel(condition.algorithm) + '</th><th>개선량 Δ</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const key of ['stoi', 'estoi']) { const row = document.createElement('tr'), delta = improvement(processed, baseline, key); row.append(node('td', '', key.toUpperCase()), node('td', '', format(baseline?.[key])), node('td', '', format(processed?.[key])), node('td', delta === null ? 'muted' : delta >= 0 ? 'positive' : 'negative', delta === null ? '미계산' : `${delta > 0 ? '+' : ''}${format(delta)}`)); body.append(row); }
  table.append(body); $('#metric-comparison').replaceChildren(table);
  if (baseline || processed) $('#metric-comparison').append(node('p', 'microcopy', `계산 도구 버전 · 무처리: ${baseline?.tool_version || '미입력'} / SS: ${processed?.tool_version || '미입력'}`));
}
function summaryLine(label, value, suffix = '') { const line = node('div', 'summary-item', label), number = node('strong', '', value); if (suffix) number.append(node('small', '', ` ${suffix}`)); line.append(number); return line; }
function renderEvaluation() {
  const selectedAlgorithm = SAMPLE_INDEX.get($('#rating-sample').value)?.algorithm || condition.algorithm;
  const id = conditionId(condition.noise, condition.snr, condition.statement);
  $('#rating-sample').replaceChildren(...EVALUATION_METHODS.map(method => option(id + '_' + method.id, method.label)));
  $('#rating-sample').value = id + '_' + selectedAlgorithm;
  for (const key of ['noise', 'snr', 'statement']) $('#listening-condition [name=' + key + ']').value = String(condition[key]);
  renderRatingPreview();
  $('#rating-condition').textContent = conditionLabel();
  renderRatingSummary();
  $('#records-count').textContent = `전체 ${allRatings().length}개 응답`;
  const rows = allRatings().reverse().map(record => {
    const tr = document.createElement('tr');
    const rate = record.key_total === null ? '채점 전' : `${(record.key_correct / record.key_total * 100).toFixed(1)}%`;
    [record.listener_id, record.sample_id, rate, record.noise, record.naturalness].forEach((value, index) => tr.append(node('td', index === 1 ? 'code' : '', String(value))));
    tr.append(node('td', '', record.survey_response_id ? 'QR · ' + record.survey_session_code : '수동 입력')); return tr;
  });
  if (!rows.length) { const tr = document.createElement('tr'), td = node('td', 'empty-cell', '아직 저장된 청음 응답이 없습니다.'); td.colSpan = 6; tr.append(td); rows.push(tr); }
  $('#records-body').replaceChildren(...rows);
  renderDeletionControls();
}
function renderDeletionControls() {
  const select = $('#delete-qr-code'), previous = select.value;
  const options = qrSessions.map(session => ({ code: session.code, label: session.title + ' · ' + session.code + ' · 응답 ' + session.response_count + '개' }));
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(option('', qrSessions.length ? '삭제할 QR 회차를 선택하세요' : '삭제할 QR 회차가 없습니다'), ...options.map(row => option(row.code, row.label)));
    if (qrSessions.some(session => session.code === previous)) select.value = previous;
    select.dataset.options = signature;
  }
  const session = qrSessions.find(row => row.code === select.value);
  select.disabled = saving || !qrListReady;
  $('#delete-qr-session').disabled = saving || !qrListReady || !session;
  $('#qr-delete-summary').textContent = session ? session.title + ' · 음원 ' + session.sample_count + '개 · 참가자 ' + session.participant_count + '명 · 응답 ' + session.response_count + '개 · 생성 ' + new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(session.created_at)) : 'QR 회차 하나를 선택하면 삭제할 범위를 확인할 수 있습니다.';
}
async function readQRSessions() {
  const response = await fetch('/api/survey-sessions', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'QR 목록을 읽지 못했습니다.');
  if (saving || payload.revision < revision || qrListReady && payload.revision < qrListRevision) return;
  qrSessions = payload.sessions; qrListRevision = payload.revision; qrListReady = true;
  renderDeletionControls();
}
async function deleteSelectedQR() {
  const session = qrSessions.find(row => row.code === $('#delete-qr-code').value), expectedRevision = qrListRevision;
  if (saving || !qrListReady || !session) return;
  if (!confirm('QR 회차 「' + session.title + '」를 삭제할까요?\nQR: ' + session.code + '\n음원 ' + session.sample_count + '개 · 참가자 ' + session.participant_count + '명 · 응답 ' + session.response_count + '개\n삭제 후 이 QR과 진행자 링크는 사용할 수 없고, 이 회차의 응답 전체가 결과 집계에서 제외됩니다.')) return;
  saving = true; renderDeletionControls();
  try {
    const response = await fetch('/api/survey-sessions/' + session.code, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: expectedRevision }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'QR을 삭제하지 못했습니다.');
    state = normalizeBackup(payload.state); revision = payload.revision; setSurveyRatings(payload.survey_ratings);
    qrSessions = qrSessions.filter(row => row.code !== session.code); qrListReady = false;
    renderAll(); notify('QR 회차 「' + session.title + '」를 삭제했습니다.');
  } catch (error) { notify(error.message, true); }
  finally { saving = false; renderDeletionControls(); await refreshListeningResults(); }
}
async function refreshListeningResults(announce = false) {
  if (refreshingResults || saving) return;
  refreshingResults = true; $('#refresh-listening').disabled = true;
  try {
    if (await readCloudState()) renderAll();
    await readQRSessions();
    $('#listening-sync-status').textContent = '서버 응답 확인 · ' + new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', timeStyle: 'medium' }).format(new Date());
    if (announce) notify('청음 응답과 결과표를 새로고침했습니다.');
  } catch (error) { $('#listening-sync-status').textContent = error.message; if (announce) notify(error.message, true); }
  finally { refreshingResults = false; $('#refresh-listening').disabled = false; }
}
function renderRatingSummary() {
  const group = aggregateRatings(allRatings()).find(row => row.sample_id === $('#rating-sample').value);
  $('#rating-count').textContent = `${group?.count || 0} RESPONSES`;
  const content = node('div', 'summary-list');
  const keyRate = group?.grading_mixed ? '기준 혼재' : Number.isFinite(group?.key_rate) ? `${(group.key_rate * 100).toFixed(1)}%` : '채점 전';
  content.append(summaryLine('이해도 · 핵심정보 정답률', keyRate));
  for (const { name, label } of RATING_SCALES) content.append(summaryLine(label + ' 평균', format(group?.[name], 2), '/ 10'));
  if (group?.grading_version) content.append(node('p', 'microcopy', `채점표 ${group.grading_version} · 채점 응답 ${group.graded_count}개`));
  if (group?.grading_mixed) content.append(node('p', 'grade-note', '서로 다른 채점 기준을 합산하지 않습니다. 기준을 확인하세요.'));
  if (group?.count) {
    const details = node('details', 'rating-distribution');
    details.append(node('summary', '', '5단계 응답 분포 보기'));
    const table = node('table', 'distribution-table');
    table.innerHTML = '<caption class="sr-only">선택 음원의 소음 방해·자연스러움 응답 분포</caption><thead><tr><th scope="col">점수</th><th scope="col">소음 방해</th><th scope="col">자연스러움</th></tr></thead>';
    const body = document.createElement('tbody');
    SCORE_LEVELS.forEach((score, index) => {
      const row = document.createElement('tr'), heading = node('th', '', String(score)); heading.scope = 'row';
      row.append(heading, node('td', '', group.noise_distribution[index].count + '개'), node('td', '', group.naturalness_distribution[index].count + '개')); body.append(row);
    });
    table.append(body); details.append(table); content.append(details);
  }
  $('#rating-summary').replaceChildren(content);
}
function analysisData() {
  const filters = Object.fromEntries(new FormData($('#analysis-filters')));
  const pairs = pairedSamples(allMetrics(), allRatings(), {
    ...filters, grading_version: filters.measure === 'key_rate' ? filters.grading_version : 'all',
  });
  const correlations = correlationResults(pairs, filters.measure);
  return { version: 2, generated_at: new Date().toISOString(), analysis_unit: 'sample_id', primary_measure: 'key_rate', filters, correlations, pairs };
}
function renderAnalysis() {
  const versionSelect = $('#analysis-filters [name=grading_version]'), previous = versionSelect.value;
  const versions = [...new Set(allRatings().map(row => row.grading_version).filter(Boolean))].sort();
  versionSelect.replaceChildren(option('all', '전체 기준'), ...versions.map(value => option(value, value)));
  if (versions.includes(previous)) versionSelect.value = previous;
  const { pairs, correlations, filters } = analysisData(), label = measureLabel(filters.measure);
  $('#grading-filter').hidden = filters.measure !== 'key_rate';
  $('#correlation-stats').replaceChildren(...['stoi', 'estoi'].map(key => statCard(key.toUpperCase() + ' ↔ ' + label + ' · ρ', format(correlations[key].rho), '', correlations[key].reason || '대응 음원 ' + correlations[key].n + '개')), statCard('청음 응답이 있는 음원', pairs.length, '', '실측 지표가 있는 음원만 상관분석'));
  for (const key of ['stoi', 'estoi']) renderScatter(pairs, filters.measure, correlations[key].reason, key, $('#graph-' + key + '-human'));
  $('#analysis-note').textContent = 'Spearman 순위상관 · 각 점은 같은 음원 1개이며 n은 대응 음원 수입니다. ' + label + '와 비교하며 항목들을 합산하지 않습니다. 주 분석은 핵심정보 정답률이고, 소음 방해·자연스러움은 보조 분석입니다. 3문장을 반복한 탐색적 결과입니다.';
  const rows = pairs.map(pair => {
    const sample = SAMPLE_INDEX.get(pair.sample_id), row = document.createElement('tr');
    const title = node('td', 'sample-description', algorithmLabel(sample.algorithm) + ' · ' + NOISES.find(noise => noise.id === sample.noise).label + ' · ' + sample.snr + ' dB');
    title.append(node('small', '', STATEMENTS.find(statement => statement.id === sample.statement).label), node('small', 'code', pair.sample_id));
    row.append(title);
    [format(pair.stoi), format(pair.estoi), pair.grading_mixed ? '기준 혼재' : percentage(pair.key_rate), format(pair.noise, 2), format(pair.naturalness, 2), pair.count, pair.grading_mixed ? '기준 혼재' : pair.grading_version || '채점 전'].forEach(value => row.append(node('td', '', String(value))));
    return row;
  });
  if (!rows.length) { const row = document.createElement('tr'), cell = node('td', 'empty-cell', '청음 응답을 저장하면 같은 음원의 지표와 청음결과를 비교합니다.'); cell.colSpan = 8; row.append(cell); rows.push(row); }
  $('#pairs-body').replaceChildren(...rows);
}
function renderGraphs() {
  const filters = Object.fromEntries(new FormData($('#graph-filters')));
  const metrics = allMetrics(), comparison = objectiveComparison(metrics, filters.algorithm, filters);
  const values = Object.values(comparison).flat().flatMap(point => [point.baseline, point.processed]).filter(Number.isFinite);
  const minimum = values.some(value => value < 0) ? -1 : 0;
  $('#graph-method-label').textContent = algorithmLabel(filters.algorithm);
  const summary = [];
  for (const key of ['stoi', 'estoi']) {
    renderMetricTrend($('#graph-' + key + '-trend'), comparison[key], key, filters.algorithm, minimum);
    const count = comparison[key].reduce((sum, point) => sum + point.count, 0);
    const delta = count ? comparison[key].reduce((sum, point) => sum + point.delta * point.count, 0) / count : null;
    const value = Number.isFinite(delta) ? (delta > 0 ? '+' : '') + format(delta) : '—';
    summary.push(statCard('평균 Δ' + key.toUpperCase(), value, '', '처리 − 무처리 · 같은 조건 ' + count + '개'));
  }
  $('#graph-summary').replaceChildren(...summary);
}

function renderScatter(pairs, measure, reason, metric, target) {
  const valid = pairs.filter(pair => Number.isFinite(pair[metric]) && Number.isFinite(pair[measure]));
  if (!valid.length || reason === '같은 채점 기준 버전을 선택하세요') {
    const empty = node('div', 'chart-empty'); empty.append(node('strong', '', reason === '같은 채점 기준 버전을 선택하세요' ? reason : '청음 응답 입력 대기'), node('p', '', '같은 음원의 실측 지표와 청음 응답을 연결하면 분포가 표시됩니다.')); target.replaceChildren(empty); return;
  }
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 760 350'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', metric.toUpperCase() + '와 ' + measureLabel(measure) + ' 산점도, 음원 ' + valid.length + '개');
  const min = Math.min(0, ...valid.map(pair => pair[metric])), max = Math.max(1, ...valid.map(pair => pair[metric])), ceiling = measure === 'key_rate' ? 1 : 10;
  const x = value => 58 + (value - min) / (max - min) * 660, y = value => 296 - value / ceiling * 260;
  const add = (tag, attrs, text) => { const element = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value)); if (text !== undefined) element.textContent = text; svg.append(element); return element; };
  for (const fraction of [0, .25, .5, .75, 1]) { const value = fraction * ceiling; add('line', { x1: 58, x2: 718, y1: y(value), y2: y(value), stroke: '#e4ebdf' }); add('text', { x: 44, y: y(value) + 4, 'text-anchor': 'end', fill: '#647d68', 'font-size': 11 }, measure === 'key_rate' ? (value * 100) + '%' : value); }
  for (let i = 0; i <= 4; i++) { const value = min + (max - min) / 4 * i; add('text', { x: x(value), y: 318, 'text-anchor': 'middle', fill: '#647d68', 'font-size': 11 }, value.toFixed(2)); }
  add('text', { x: 58, y: 18, fill: '#526c57', 'font-size': 11 }, measureLabel(measure) + (measure === 'key_rate' ? ' (%)' : ' 평균 / 10')); add('text', { x: 718, y: 342, 'text-anchor': 'end', fill: '#526c57', 'font-size': 11 }, metric.toUpperCase());
  const colors = { noisy: '#bd7736', ss_fixed: '#174e47', ss_pattern_fixed: '#537faa', ss_pattern_update: '#8d6eaa', additional: '#bc6778' };
  for (const pair of valid) { const circle = add('circle', { cx: x(pair[metric]), cy: y(pair[measure]), r: 6, fill: colors[SAMPLE_INDEX.get(pair.sample_id).algorithm], opacity: '.8' }); const title = document.createElementNS(ns, 'title'); title.textContent = pair.sample_id + ': ' + metric.toUpperCase() + ' ' + format(pair[metric]) + ', ' + measureLabel(measure) + ' ' + (measure === 'key_rate' ? percentage(pair[measure]) : format(pair[measure], 2)) + ', 응답 ' + pair.count + '개'; circle.append(title); }
  target.replaceChildren(svg);
}
function renderSettings() {
  const connected = [...SAMPLES, ...NOISE_SOURCES].filter(isConnected).length;
  $('#connection-status').textContent = scanError || `연결된 음원 ${connected} / 186개 · 기준 3개 + 소음 3개 + 무처리 36개 + 처리 결과 144개.`;
  const usable = allMetrics().length, withheld = mergeMetrics(state.metrics, serverMetrics).length - usable;
  $('#metrics-status').textContent = `현재 입력에 대응하는 실측 지표 ${usable}개 / 평가 후보 180개${withheld ? ` · 파일 변경·임시 연결 등으로 ${withheld}개 표시 보류` : ''}`;
  $('#objective-status').textContent = $('#metrics-status').textContent;
  $('#storage-status').textContent = storageError || `클라우드 DB에 청음 응답 ${allRatings().length}개 · 가져온 지표 ${state.metrics.length}개 저장 · 자료 버전 ${revision}. 로컬 폴더의 음원은 배포할 때 반영됩니다.`;
  $('#storage-status').classList.toggle('error', Boolean(storageError));
}
function renderAll() { renderStats(); renderLibrary(); renderComparison(); renderEvaluation(); renderMatrices(); renderObjective(); renderGraphs(); renderAnalysis(); renderSettings(); }
async function scanFiles(render = true) {
  const previousCatalog = JSON.stringify([...[...availablePaths].sort(), inputFingerprints]);
  $('#refresh-files').disabled = true;
  try {
    const response = await fetch(new URL('../api/files', location.href), { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    if (!Array.isArray(payload.files)) throw new Error();
    availablePaths = new Set(payload.files); inputFingerprints = payload.fingerprints || {}; scanError = '';
  } catch { availablePaths = new Set(); inputFingerprints = {}; scanError = '서버의 음원 목록을 확인하지 못했습니다. 연결 상태를 새로고침하세요.'; }
  finally { $('#refresh-files').disabled = false; if (render) renderAll(); }
  return previousCatalog !== JSON.stringify([...[...availablePaths].sort(), inputFingerprints]);
}
function importWith(selector, handler) {
  $(selector).addEventListener('change', async event => {
    const input = event.target, file = input.files[0]; if (!file) return;
    try { if (file.size > 10 * 1024 * 1024) throw new Error('CSV·JSON은 10 MB 이하 파일로 나누어 가져오세요.'); await handler(await file.text(), file.name); renderAll(); }
    catch (error) { notify(error.message || '파일을 확인하세요.', true); }
    finally { input.value = ''; }
  });
}
function bindEvents() {
  $('#library-player').addEventListener('play', event => stopAudio(event.target));
  document.querySelectorAll('[data-objective]').forEach(button => button.addEventListener('click', () => {
    selectedObjective = button.dataset.objective;
    document.querySelectorAll('[data-objective]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
    renderObjective();
  }));
  $('#rating-table-algorithm').addEventListener('change', renderMatrices);
  $('#objective-filters').addEventListener('change', renderObjective);
  $('#chart-algorithm').addEventListener('change', renderObjective);
  $('#graph-filters').addEventListener('change', renderGraphs);
  $('#go-rating-form').addEventListener('click', openRatingForm);
  $('#listening-condition').addEventListener('change', () => { const fields = Object.fromEntries(new FormData($('#listening-condition'))); selectCondition({ ...fields, snr: Number(fields.snr) }); });
  $('#rating-form').addEventListener('input', renderRatingPreview);
  $('#print-report').addEventListener('click', () => { prepareReport(); window.print(); });
  $('#export-results').addEventListener('click', () => download('research-results.csv', csvText(resultRows(allMetrics(), allRatings()), REPORT_FIELDS), 'text/csv;charset=utf-8'));
  $('#export-listening').addEventListener('click', () => download('listening-results.csv', csvText(resultRows(allMetrics(), allRatings()).filter(row => row.responses), REPORT_FIELDS), 'text/csv;charset=utf-8'));
  $('#condition-form').addEventListener('submit', event => event.preventDefault());
  $('#condition-form').addEventListener('change', () => { const fields = Object.fromEntries(new FormData($('#condition-form'))); Object.assign(condition, fields, { snr: Number(fields.snr) }); renderAll(); });
  $('#rating-sample').addEventListener('change', () => { renderRatingSummary(); renderRatingPreview(); });
  $('#rating-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try { const record = normalizeRatings([Object.fromEntries(new FormData(form))]); mergeRatings(allRatings(), record); await persist({ ...state, ratings: mergeRatings(state.ratings, record) }); const savedSample = record[0].sample_id; form.reset(); $('#rating-sample').value = savedSample; $('#rating-table-algorithm').value = 'all'; renderAll(); $('#rating-feedback').textContent = '응답을 저장하고 정답률·5단계 결과표 및 지표 비교를 갱신했습니다.'; $('#rating-feedback').classList.remove('error'); }
    catch (error) { $('#rating-feedback').textContent = error.message; $('#rating-feedback').classList.add('error'); }
  });
  $('#analysis-filters').addEventListener('change', renderAnalysis);
  $('#refresh-files').addEventListener('click', refreshServerData);
  $('#refresh-listening').addEventListener('click', () => refreshListeningResults(true));
  $('#delete-qr-code').addEventListener('change', renderDeletionControls);
  $('#delete-qr-session').addEventListener('click', deleteSelectedQR);
  $('#export-ratings').addEventListener('click', () => download('listening-responses.csv', csvText(allRatings(), RATING_FIELDS), 'text/csv;charset=utf-8'));
  $('#rating-template').addEventListener('click', () => download('paper-ratings-template.csv', csvText([], RATING_FIELDS), 'text/csv;charset=utf-8'));
  $('#metric-template').addEventListener('click', () => download('stoi-estoi-template.csv', csvText([], ['sample_id', 'stoi', 'estoi', 'tool_version']), 'text/csv;charset=utf-8'));
  $('#export-manifest').addEventListener('click', () => download('dataset.json', JSON.stringify({ version: 1, samples: SAMPLES.map(sample => ({ ...sample, path: pathFor(sample) })), noise_sources: NOISE_SOURCES.map(source => ({ id: source.id, path: pathFor(source) })) }, null, 2)));
  $('#export-backup').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/backup', { cache: 'no-store' }), backup = await response.json();
      if (!response.ok) throw new Error(backup.error || '백업을 읽지 못했습니다.');
      download(`research-backup-${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())}.json`, JSON.stringify(backup, null, 2));
    } catch (error) { notify(error.message, true); }
  });
  $('#export-analysis').addEventListener('click', () => download('spearman-analysis.json', JSON.stringify(analysisData(), null, 2)));
  importWith('#import-metrics', async (text, filename) => { const rows = normalizeMetrics(parseRecords(text, filename, 'metrics')); if (!rows.length) throw new Error('가져올 지표 행이 없습니다.'); await persist({ ...state, metrics: mergeMetrics(state.metrics, rows) }); notify(`음원 ${rows.length}개의 실측 지표를 저장했습니다.`); });
  importWith('#import-ratings', async (text, filename) => { const rows = normalizeRatings(parseRecords(text, filename, 'ratings')); if (!rows.length) throw new Error('가져올 응답 행이 없습니다.'); mergeRatings(allRatings(), rows); await persist({ ...state, ratings: mergeRatings(state.ratings, rows) }); notify(`종이 응답 ${rows.length}개를 저장했습니다.`); });
  importWith('#import-manifest', async text => { const input = JSON.parse(text), paths = normalizeManifest(input), noise_paths = normalizeNoiseSources(input.noise_sources || []); await persist({ ...state, paths: { ...state.paths, ...paths }, noise_paths: { ...state.noise_paths, ...noise_paths } }); notify(`음원 ${Object.keys(paths).length + Object.keys(noise_paths).length}개의 경로 설정을 저장했습니다.`); });
  importWith('#import-backup', async text => {
    const backup = JSON.parse(text); normalizeBackup(backup.version === 2 ? backup.study : backup);
    const message = backup.version === 2 ? '백업의 수동 자료·QR 회차·원응답으로 서버 자료를 복원할까요?' : '이전 형식의 수동 자료를 복원할까요? 현재 QR 회차와 원응답은 보관됩니다.';
    if (!confirm(message)) return;
    const response = await fetch('/api/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, backup }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '백업 복원에 실패했습니다.');
    await refreshServerData(); notify('백업을 복원했습니다.');
  });
  window.addEventListener('hashchange', navigate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshListeningResults(); });
}
function navigate() {
  let requested = location.hash.slice(1);
  if (requested === 'comparison') requested = 'demo';
  if (requested === 'evaluation') requested = 'metrics';
  const valid = ['collection', 'demo', 'metrics', 'graphs', 'listening-test', 'listening', 'analysis', 'settings'], page = valid.includes(requested) ? requested : 'collection';
  stopAudio();
  document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== page; });
  document.querySelectorAll('.nav-link').forEach(link => { const active = link.hash === '#' + page; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#page-name').textContent = { collection: '데이터파일', demo: 'SS 결과물', metrics: 'STOI ESTOI', graphs: 'STOI ESTOI 지표 분석', 'listening-test': '청음평가', listening: '청음결과표', analysis: '지표청음 비교', settings: '데이터 설정 · 백업' }[page];
  document.querySelector('.nav-link.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  window.scrollTo(0, 0);
  if (storageReady && ['listening', 'analysis'].includes(page)) refreshListeningResults();
}
function openRatingForm() {
  if (location.hash !== '#listening-test') history.pushState(null, '', '#listening-test');
  navigate();
  $('#rating-form').scrollIntoView({ block: 'start' });
  $('#rating-form [name=listener_id]').focus({ preventScroll: true });
}
async function refreshServerData() {
  try { await readCloudState(); } catch (error) { storageError = error.message; notify(storageError, true); }
  const loads = await Promise.allSettled([readServerJSON('data/metadata/dataset.json'), readServerJSON('metrics/results/stoi_estoi.json')]);
  try { if (loads[0].status === 'fulfilled' && loads[0].value) { serverPaths = normalizeManifest(loads[0].value); serverNoisePaths = normalizeNoiseSources(loads[0].value.noise_sources || []); } else throw new Error('기본 경로 설정을 확인하지 못했습니다.'); }
  catch (error) { notify(error.message, true); }
  serverMetrics = [];
  try { if (loads[1].status === 'rejected') throw new Error('결과 파일을 읽지 못했습니다.'); if (loads[1].value) serverMetrics = normalizeMetrics(Array.isArray(loads[1].value) ? loads[1].value : loads[1].value.metrics); }
  catch (error) { notify(`기본 지표: ${error.message}`, true); }
  await scanFiles();
}
async function initialize() {
  initializeControls(); bindEvents(); renderAll(); navigate();
  await refreshServerData();
  await refreshListeningResults();
  setInterval(() => { if (!document.hidden) refreshListeningResults(); }, 2000);
  setInterval(async () => {
    if (saving || document.hidden) return;
    try { if (await scanFiles(false)) renderAll(); }
    catch (error) { storageError = error.message; renderSettings(); }
  }, 15000);
}
function percentage(value) { return Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '채점 전'; }
function measureLabel(measure) { return { key_rate: '이해도 · 핵심정보 정답률', noise: '소음 방해 정도', naturalness: '음성 자연스러움' }[measure]; }
function renderRatingPreview() {
  const target = $('#rating-preview'), fields = Object.fromEntries(new FormData($('#rating-form')));
  try {
    const preview = previewRating(fields), content = node('div', 'summary-list');
    content.append(summaryLine('핵심 정보 정답률', preview.key_rate === null ? '채점 입력 대기' : percentage(preview.key_rate)));
    for (const key of ['noise', 'naturalness']) content.append(summaryLine(measureLabel(key), format(preview[key], 2), '/ 10'));
    target.replaceChildren(content);
  } catch (error) { target.replaceChildren(node('p', 'form-feedback error', error.message)); }
}
function renderObjective() {
  const filters = Object.fromEntries(new FormData($('#objective-filters'))), rows = resultRows(allMetrics(), allRatings(), filters);
  $('#objective-count').textContent = rows.length + '개 결과물';
  $('#objective-body').replaceChildren(...rows.map(result => {
    const row = document.createElement('tr'); row.dataset.sampleId = result.sample_id;
    for (const key of ['algorithm', 'noise', 'statement', 'snr', 'stoi', 'estoi', 'delta_stoi', 'delta_estoi']) {
      const value = result[key], delta = key.startsWith('delta_');
      row.append(node('td', delta && Number.isFinite(value) ? value >= 0 ? 'positive' : 'negative' : '', ['stoi', 'estoi'].includes(key) || delta ? Number.isFinite(value) ? (delta && value > 0 ? '+' : '') + format(value) : '—' : String(value)));
    }
    return row;
  }));
  const algorithm = $('#chart-algorithm').value, summary = snrSummary(allMetrics(), algorithm, selectedObjective);
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 760 210'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', algorithmLabel(algorithm) + ' SNR별 ' + selectedObjective.toUpperCase() + ' 평균');
  const add = (tag, attrs, text) => { const item = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value); if (text !== undefined) item.textContent = text; svg.append(item); };
  add('line', { x1: 390, x2: 390, y1: 10, y2: 184, stroke: '#aab9ad' });
  add('text', { x: 110, y: 204, fill: '#657a69', 'font-size': 11 }, '−1');
  add('text', { x: 390, y: 204, fill: '#657a69', 'font-size': 11 }, '0');
  add('text', { x: 670, y: 204, fill: '#657a69', 'font-size': 11 }, '1');
  summary.forEach((entry, index) => {
    const y = 15 + index * 43;
    add('text', { x: 5, y: y + 19, fill: '#365b48', 'font-size': 12 }, entry.snr + ' dB');
    add('rect', { x: 110, y, width: 560, height: 28, fill: '#f0f4ed', rx: 4 });
    if (entry.mean !== null) add('rect', { x: entry.mean < 0 ? 390 + entry.mean * 280 : 390, y, width: Math.abs(entry.mean) * 280, height: 28, fill: entry.mean < 0 ? '#b46b4c' : '#34705b', rx: 3 });
    add('text', { x: 685, y: y + 18, fill: '#466350', 'font-size': 10 }, entry.mean === null ? '미계산' : format(entry.mean) + ' · n=' + entry.count);
  });
  $('#objective-chart').replaceChildren(svg);
}
function renderLibrary() {
  for (const [target, sources] of [['clean-library', SAMPLES.filter(sample => sample.kind === 'clean')], ['noise-library', NOISE_SOURCES]]) {
    const rows = sources.map(sample => {
      const statement = STATEMENTS.find(item => item.id === sample.statement);
      const row = node('div', 'source-row'), text = node('div', 'source-label');
      text.append(node('strong', '', statement ? statement.label : sample.label), node('small', '', statement ? statement.speaker : '소음 원본 · 지표 계산 제외'));
      const play = node('button', 'source-play', isConnected(sample) ? '재생 ▶' : '연결 대기');
      play.type = 'button'; play.disabled = !isConnected(sample);
      play.setAttribute('aria-label', (statement ? statement.label + ' ' + statement.speaker : sample.label) + ' 재생');
      play.addEventListener('click', () => playLibrary(sample));
      const actions = node('div', 'source-actions');
      actions.append(play); row.append(text, actions); return row;
    });
    document.getElementById(target).replaceChildren(...rows);
  }
}
function playAudioElement(audio) {
  stopAudio(audio);
  audio.play().catch(() => notify('플레이어의 재생 버튼을 눌러 주세요. WAV 형식과 재생 장치를 확인하세요.', true));
}
function playLibrary(sample) {
  const audio = $('#library-player');
  audio.src = audioURL(sample);
  audio.hidden = false;
  const statement = STATEMENTS.find(item => item.id === sample.statement);
  $('#library-caption').textContent = sample.kind === 'noise' ? sample.label + ' · 소음 원본' : statement.label + ' · ' + statement.speaker + (sample.kind === 'clean' ? ' · 깨끗한 기준 음성' : ' · ' + NOISES.find(item => item.id === sample.noise).label + ' · SNR ' + sample.snr + ' dB');
  audio.onerror = () => notify('음원을 재생하지 못했습니다. WAV 파일을 확인하세요.', true);
  playAudioElement(audio);
}
function selectCondition(cell) {
  Object.assign(condition, { noise: cell.noise, snr: cell.snr, statement: cell.statement });
  for (const name of ['noise', 'snr', 'statement']) {
    document.querySelectorAll('#condition-form input[name=' + name + ']').forEach(input => { input.checked = input.value === String(condition[name]); });
  }
  renderAll();
}
function renderMatrices() {
  for (const [container, mode] of [['mixed-matrix', 'noisy'], ['demo-matrix', condition.algorithm], ['accuracy-matrix', 'accuracy'], ['human-matrix', 'human']]) document.getElementById(container).replaceChildren(createMatrix(mode));
  const rows = allRatings(), algorithm = $('#rating-table-algorithm').value;
  const visible = rows.filter(row => algorithm === 'all' || SAMPLE_INDEX.get(row.sample_id).algorithm === algorithm);
  $('#listening-results-status').textContent = '저장된 전체 응답 ' + rows.length + '개 · 현재 표에 포함된 응답 ' + visible.length + '개' + (algorithm !== 'all' && !visible.length && rows.length ? ' · 전체 방식을 선택하면 다른 방식의 응답을 확인할 수 있습니다.' : '');
}
function createMatrix(mode, printable = false) {
  const groups = new Map(aggregateRatings(allRatings()).map(row => [row.sample_id, row])), table = node('table', 'condition-matrix');
  const caption = node('caption', 'sr-only', (mode === 'accuracy' ? '정답률' : mode === 'human' ? '5단계 평가' : algorithmLabel(mode)) + ' 소음·문장 9행, SNR 4열');
  const head = document.createElement('thead'), header = document.createElement('tr');
  for (const label of ['소음', '문장', ...SNRS.map(snr => snr + ' dB')]) { const th = node('th', '', label); th.scope = 'col'; header.append(th); } head.append(header);
  const body = document.createElement('tbody');
  conditionRows().forEach((group, index) => {
    const tr = document.createElement('tr');
    if (index % STATEMENTS.length === 0) { const th = node('th', 'noise-heading', group.noise.label); th.scope = 'rowgroup'; th.rowSpan = STATEMENTS.length; tr.append(th); }
    const heading = node('th', 'statement-heading', group.statement.label); heading.scope = 'row'; heading.append(node('small', '', group.statement.speaker)); tr.append(heading);
    for (const cell of group.cells) {
      const td = document.createElement('td'); td.classList.toggle('selected-condition', !printable && cell.noise === condition.noise && cell.statement === condition.statement && cell.snr === condition.snr);
      const human = ['human', 'accuracy'].includes(mode);
      if (human) {
        const items = listeningCellResults(groups, cell, $('#rating-table-algorithm').value);
        if (!items.length) td.append(node('span', 'muted', '응답 대기'));
        for (const { method, sampleId, result } of items) {
          const button = node(printable ? 'span' : 'button', 'matrix-button listening-result');
          if (!printable) button.type = 'button';
          button.append(node('small', 'listening-method', method.label), node('strong', mode === 'human' ? 'listening-score' : '', mode === 'accuracy' ? result?.grading_mixed ? '기준 혼재' : percentage(result?.key_rate) : result ? '소음 방해 ' + format(result.noise, 2) : '응답 대기'));
          if (mode === 'human' && result) button.append(node('strong', 'listening-score', '자연스러움 ' + format(result.naturalness, 2)));
          button.append(node('small', '', '응답 ' + (result?.count || 0) + '개' + (mode === 'accuracy' ? ' · 채점 ' + (result?.graded_count || 0) + '개' : '')));
          if (mode === 'accuracy' && result?.grading_version) button.append(node('small', '', result.grading_version));
          if (!printable) {
            button.setAttribute('aria-label', group.noise.label + ' ' + group.statement.label + ' ' + cell.snr + ' dB ' + method.label + ' 평가 입력');
            button.addEventListener('click', () => { selectCondition(cell); $('#rating-sample').value = sampleId; renderRatingSummary(); renderRatingPreview(); openRatingForm(); });
          }
          td.append(button);
        }
      } else {
        const sample = SAMPLE_INDEX.get(cell[mode]), button = node(printable ? 'span' : 'button', 'matrix-button');
        if (!printable) button.type = 'button';
        button.textContent = isConnected(sample) ? printable ? '연결됨' : '재생 ▶' : '연결 대기';
        if (!printable) { button.disabled = !isConnected(sample); button.dataset.sampleId = sample.id; button.addEventListener('click', () => { selectCondition(cell); if (mode === 'noisy') playLibrary(sample); else { $('#demo-detail').scrollIntoView({ block: 'start' }); const audio = document.querySelector('[data-sample-id="' + sample.id + '"] audio'); if (audio) playAudioElement(audio); } }); }
        if (!printable) button.setAttribute('aria-label', group.noise.label + ' ' + group.statement.label + ' ' + cell.snr + ' dB ' + algorithmLabel(mode) + ' 재생');
        td.append(button);
      }
      tr.append(td);
    }
    body.append(tr);
  });
  table.append(caption, head, body); return table;
}
function prepareReport() {
  let report = $('#print-report-content');
  if (!report) { report = node('div'); report.id = 'print-report-content'; $('main').append(report); }
  report.replaceChildren();
  const section = (title, content) => { const article = node('section', 'report-section'); article.append(node('h2', '', title), content); report.append(article); };
  const sources = node('p', '', '깨끗한 음원 ' + SAMPLES.filter(sample => sample.kind === 'clean' && isConnected(sample)).length + '/3 · 소음 원본 ' + NOISE_SOURCES.filter(isConnected).length + '/3 · 입력 SNR 20/10/5/0 dB');
  section('01. 데이터파일', sources); report.lastElementChild.append(createMatrix('noisy', true));
  for (const algorithm of ALGORITHMS) section('02. ' + algorithm.label + ' 결과물', createMatrix(algorithm.id, true));
  const table = node('table', 'report-results');
  table.innerHTML = '<thead><tr><th>처리 / 조건</th><th>STOI</th><th>ESTOI</th><th>Δ S</th><th>Δ E</th><th>핵심정보 정답률</th><th>소음</th><th>자연</th><th>응답 수</th><th>채점 기준</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const result of resultRows(allMetrics(), allRatings())) {
    const row = document.createElement('tr');
    [result.algorithm + ' / ' + result.noise + ' / ' + result.statement + ' / ' + result.snr + ' dB', format(result.stoi), format(result.estoi), format(result.delta_stoi), format(result.delta_estoi), result.grading_mixed ? '기준 혼재' : percentage(result.key_rate), format(result.noise_score, 2), format(result.naturalness, 2), result.responses, result.grading_mixed ? '기준 혼재' : result.grading_version || '—'].forEach(value => row.append(node('td', '', String(value))));
    body.append(row);
  }
  table.append(body); section('STOI ESTOI 및 음원별 청음결과표', table);
  const graphs = node('div');
  const filterText = selector => [...document.querySelectorAll(selector + ' select')].filter(select => !select.closest('label')?.hidden).map(select => select.selectedOptions[0].textContent).join(' · ');
  const cloneForReport = selector => {
    const copy = $(selector).cloneNode(true);
    copy.removeAttribute('id');
    copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    return copy;
  };
  graphs.append(node('p', '', '그래프 조건 · ' + filterText('#graph-filters')), cloneForReport('#graph-trends'), cloneForReport('#graph-summary'));
  section('04. STOI ESTOI 지표 분석', graphs);
  const analysis = node('div'); analysis.append(node('p', '', '적용 필터: ' + filterText('#analysis-filters')), cloneForReport('#correlation-stats'), cloneForReport('#graph-human-charts'), node('p', '', $('#analysis-note').textContent));
  section('07. 지표청음 비교', analysis);
  $('#report-date').textContent = '작성 시각: ' + new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' }).format(new Date());
}
initialize().catch(error => notify(`화면 준비 중 오류: ${error.message}`, true));
