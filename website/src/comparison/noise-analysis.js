import { createPeakAnalysis } from './peak-analysis.js';
import { NOISES, NOISE_SOURCES, STATEMENTS, SNRS, SAMPLE_INDEX, conditionId } from './dataset.js';
import { normalizeNoiseAnalysis, noiseAnalysisMatches } from './noise-analysis-data.js';

const $ = selector => document.querySelector(selector);
const element = (tag, className = '', text = '') => {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
};
const number = (value, suffix = '') => Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + suffix : '—';
const overlapLabel = value => ({ weak: '원음 성분 약함', present: '원음과 겹침', unknown: '확인 필요' })[value];
const judgmentLabel = value => ({ candidate: '억제 후보', review: '검토 필요', hold: '보류' })[value];

function empty(title, description) {
  const box = element('div', 'artifact-empty');
  box.append(element('strong', '', title), element('span', '', description)); return box;
}
function table(target, headers, rows, message) {
  const result = element('table'), head = element('thead'), headings = element('tr'), body = element('tbody');
  for (const label of headers) { const cell = element('th', '', label); cell.scope = 'col'; headings.append(cell); }
  head.append(headings);
  for (const values of rows) { const row = element('tr'); for (const value of values) row.append(element('td', '', String(value))); body.append(row); }
  if (!rows.length) { const row = element('tr'), cell = element('td', 'empty-cell', message); cell.colSpan = headers.length; row.append(cell); body.append(row); }
  result.append(head, body); $(target).replaceChildren(result);
}
function definitions(target, pairs) {
  $(target).replaceChildren(...pairs.map(([label, value]) => { const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); return row; }));
}
function artifact(target, path, record, title, description) {
  const host = $(target);
  if (!path) { host.replaceChildren(empty(title + ' 등록 대기', description)); return; }
  const figure = element('figure', 'noise-figure'), image = element('img');
  const url = new URL('../dataset/noise_analysis/' + path, location.href);
  url.searchParams.set('v', record.inputs.map(input => input.sha256).join('-'));
  image.alt = title; image.src = url.href; image.loading = 'lazy';
  image.addEventListener('error', () => { host.replaceChildren(empty('그래프 파일 확인 필요', '분석 수치는 아래 표에서 확인할 수 있습니다.')); });
  const link = element('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('aria-label', title + ' 원본 크기로 열기'); link.append(image);
  const download = element('a', 'button secondary small', 'PNG 저장'); download.href = url.href; download.download = path.split('/').at(-1);
  figure.append(download);
  figure.append(link, element('figcaption', '', title + ' · 그래프를 누르면 원본 크기로 열립니다.')); host.replaceChildren(figure);
}

export function createNoiseAnalysis({ audioCard, pathFor, fingerprints }) {
  let data = normalizeNoiseAnalysis(null), error = '', spectrumView = 'selected';
  const selectedPeaks = new Map();
  const details = createPeakAnalysis({ fingerprints });
  const matches = record => noiseAnalysisMatches(record, pathFor, fingerprints());
  const selectedNoise = () => $('#noise-analysis-source').value || NOISES[0].id;

  async function load() {
    error = '';
    await details.load();
    try {
      const response = await fetch(new URL('../dataset/noise_analysis/results.json', location.href), { cache: 'no-store' });
      if (response.status === 404) { data = normalizeNoiseAnalysis(null); return; }
      if (!response.ok) throw new Error('분석 결과 파일을 읽지 못했습니다.');
      data = normalizeNoiseAnalysis(await response.json());
    } catch (failure) { data = normalizeNoiseAnalysis(null); error = failure.message; }
  }

  function render() {
    const noise = selectedNoise(), label = NOISES.find(item => item.id === noise).label;
    const source = NOISE_SOURCES.find(item => item.noise === noise);
    const usable = data.sources.filter(matches), record = usable.find(item => item.noise === noise), analysis = record?.analysis;
    const allRecords = [...data.sources, ...data.mixtures, ...(data.overview ? [data.overview] : [])];
    const withheld = allRecords.filter(item => !matches(item)).length;
    $('#noise-analysis-status').textContent = usable.length ? '분석 자료 ' + usable.length + ' / 3 소음 연결' : '분석 자료 등록 대기';
    $('#noise-analysis-status').classList.toggle('pending', !usable.length);
    $('#noise-analysis-status').classList.toggle('ready', Boolean(usable.length));
    $('#noise-analysis-feedback').hidden = !error && !withheld;
    $('#noise-analysis-feedback').textContent = error || '현재 음원과 파일 지문이 대응하지 않는 분석 자료 ' + withheld + '건은 표시를 보류했습니다.';
    $('#noise-analysis-library').replaceChildren(audioCard(source, label + ' · 분석할 원본', 1));
    definitions('#noise-source-metadata', [['원본 파일', pathFor(source).split('/').at(-1)], ['분석 자료', record ? '현재 원본과 대응 확인' : '등록 대기'], ['분석 구간', analysis ? '전체 음원 · ' + number(analysis.sample_count / analysis.sample_rate_hz, '초') : '전체 음원'], ['분석 샘플링', analysis ? number(analysis.sample_rate_hz, ' Hz') : '분석 자료 등록 후 표시']]);
    definitions('#noise-analysis-parameters', [['분석 방법', '전체 음원 FFT'], ['전체 샘플 수', analysis ? number(analysis.sample_count) : '미등록'], ['FFT 크기', analysis ? number(analysis.fft_size) : '미등록'], ['윈도', analysis?.window_function || '미등록'], ['크기·정규화 기준', analysis?.magnitude_reference || '미등록'], ['피크 검출 기준', analysis?.peak_rule || '미등록']]);
    document.querySelectorAll('[data-noise-spectrum-view]').forEach(button => { const active = button.dataset.noiseSpectrumView === spectrumView; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    const spectrum = spectrumView === 'all' ? (matches(data.overview) ? data.overview : null) : record;
    artifact('#noise-spectrum-artifact', spectrum?.spectrum_image, spectrum, spectrumView === 'all' ? '3개 소음 전체 FFT 비교 그래프' : label + ' 전체 FFT 그래프', '소음 전체를 분석한 주파수 그래프가 이곳에 표시됩니다.');
    $('#noise-spectrum-summary').textContent = spectrumView === 'all' ? spectrum?.comparison_basis || '세 소음의 축·크기 기준을 맞춘 비교 자료를 기다리고 있습니다.' : record?.summary || '분석 후 주요 에너지 대역과 관찰 내용을 표시합니다.';
    if (details.hasNoise(noise)) { $('#noise-spectrum-summary').textContent = '기존 C 전체 FFT를 보존했습니다. 아래의 주요 피크·합성음 비교는 별도로 계산한 Welch PSD 탐색 결과입니다.'; details.render(noise); return; }
    $('#noise-peaks-method').textContent = '';
    const feedback = details.feedback();
    if (feedback) { $('#noise-analysis-feedback').hidden = false; $('#noise-analysis-feedback').textContent = feedback; }
    const peaks = record?.peaks || [], peaksReady = Array.isArray(record?.peaks);
    $('#noise-peaks-count').textContent = peaksReady ? '등록된 피크 ' + peaks.length + '개' : '주요 피크 검출 대기';
    artifact('#noise-peaks-artifact', record?.peaks_image, record, label + ' 주요 피크 표시 그래프', '피크 위치를 표시한 전체 FFT 그래프가 이곳에 표시됩니다.');
    table('#noise-peaks-table', ['피크', '주파수 (Hz)', '크기 (dB)', '폭 (Hz)', '돌출 정도 (dB)', '관찰 내용'], peaks.map(peak => [peak.id, number(peak.frequency_hz), number(peak.magnitude_db), number(peak.bandwidth_hz), number(peak.prominence_db), peak.note || '—']), peaksReady ? '등록된 분석에서 검출된 피크가 없습니다.' : '주요 피크 검출은 대기 중입니다. 기준 확정 후 결과를 표시합니다.');
    const select = $('#noise-peak-select');
    select.replaceChildren(...(peaks.length ? peaks.map(peak => new Option(peak.id + ' · ' + number(peak.frequency_hz, ' Hz'), peak.id)) : [new Option(peaksReady ? '검출된 피크 없음' : '주요 피크 검출 대기', '')]));
    select.disabled = !peaks.length;
    select.value = peaks.some(peak => peak.id === selectedPeaks.get(noise)) ? selectedPeaks.get(noise) : peaks[0]?.id || '';
    renderZoom(record);
    renderMixture(record, source, label);
    const candidates = usable.flatMap(item => item.candidates.map(candidate => [NOISES.find(noise => noise.id === item.noise).label, number(candidate.low_hz) + '–' + number(candidate.high_hz), candidate.reason, overlapLabel(candidate.speech_overlap), candidate.stability_note || '안정성 확인 필요', judgmentLabel(candidate.judgment)]));
    table('#noise-candidates-table', ['소음', '후보 대역 (Hz)', '선정 근거', '원음과 겹침', '피크 안정성', '검토 상태'], candidates, '등록된 전처리 후보가 없습니다. 분석 후 후보 대역과 근거를 기록합니다.');
  }

  function renderZoom(record) {
    const peak = record?.peaks?.find(item => item.id === $('#noise-peak-select').value);
    artifact('#noise-peak-zoom', peak?.zoom_image, record, peak ? peak.id + ' · ' + number(peak.frequency_hz, ' Hz') + ' 확대 그래프' : '피크 확대 그래프', '피크를 선택하면 해당 주파수 주변의 상세 그래프를 확인할 수 있습니다.');
  }

  function renderMixture(record, source, label) {
    const form = $('#noise-mixture-form'), statementId = form.elements.namedItem('statement').value, snr = Number(form.elements.namedItem('snr').value);
    const statement = STATEMENTS.find(item => item.id === statementId), id = conditionId(source.noise, snr, statementId);
    const comparison = record && data.mixtures.find(item => item.noise === source.noise && item.statement === statementId && item.snr === snr && matches(item));
    $('#noise-mixture-caption').textContent = label + ' · ' + snr + ' dB · ' + statement.label + ' · ' + statement.speaker;
    $('#noise-mixture-players').replaceChildren(audioCard(SAMPLE_INDEX.get('clean_' + statementId), '깨끗한 원음 · ' + statement.label, 1), audioCard(source, '순수 소음 · ' + label, 2), audioCard(SAMPLE_INDEX.get(id + '_noisy'), '무처리 합성음원 · ' + snr + ' dB', 3));
    $('#noise-mixture-status').textContent = comparison ? '선택 조건의 비교 자료 연결' : '선택 조건의 비교 자료 등록 대기';
    $('#noise-mixture-status').classList.toggle('pending', !comparison); $('#noise-mixture-status').classList.toggle('ready', Boolean(comparison));
    artifact('#noise-mixture-artifact', comparison?.spectrum_image, comparison, label + ' · ' + statement.label + ' · ' + snr + ' dB 주파수 비교', '원음·소음·합성음원을 같은 기준으로 비교한 그래프가 이곳에 표시됩니다.');
    const observations = comparison?.observations || [];
    table('#noise-mixture-table', ['소음 피크', '소음 주파수 (Hz)', '합성음원 대응 주파수 (Hz)', '원음과 겹침', '해석'], observations.map(item => [item.peak_id, number(record.peaks.find(peak => peak.id === item.peak_id).frequency_hz), number(item.mixture_frequency_hz), overlapLabel(item.speech_overlap), item.note || '—']), '선택 조건의 피크 대응 자료가 등록되면 표시합니다. 빈 값은 미관찰 또는 미확인으로 해석합니다.');
    $('#noise-mixture-note').textContent = comparison?.comparison_basis || '비교 자료 등록 시 분석 구간·소음 크기 보정·정규화 기준을 함께 기록합니다.';
  }

  function initialize() {
    for (const statement of STATEMENTS) $('#noise-mixture-form [name=statement]').add(new Option(statement.label + ' · ' + statement.speaker, statement.id));
    for (const snr of SNRS) $('#noise-mixture-form [name=snr]').add(new Option(snr + ' dB', String(snr)));
    $('#noise-analysis-source').addEventListener('change', render);
    $('#noise-mixture-form').addEventListener('change', render);
    $('#noise-mixture-form').addEventListener('submit', event => event.preventDefault());
    document.querySelectorAll('[data-noise-spectrum-view]').forEach(button => button.addEventListener('click', () => { spectrumView = button.dataset.noiseSpectrumView; render(); }));
    $('#noise-peak-select').addEventListener('change', () => { if (details.hasNoise(selectedNoise())) { details.renderZoom(selectedNoise()); return; } selectedPeaks.set(selectedNoise(), $('#noise-peak-select').value); renderZoom(data.sources.find(item => item.noise === selectedNoise() && matches(item))); });
    document.querySelectorAll('.noise-analysis-steps a').forEach(link => link.addEventListener('click', event => { event.preventDefault(); $(link.getAttribute('href')).scrollIntoView({ block: 'start', behavior: 'smooth' }); }));
  }

  function report() {
    const result = element('div', 'noise-analysis-report');
    result.append(element('p', '', NOISES.find(noise => noise.id === selectedNoise()).label + ' · ' + $('#noise-analysis-status').textContent));
    if (!data.sources.some(matches)) {
      result.append(element('p', '', '전체 FFT·주요 피크·원음과 합성음원의 비교·전처리 후보 자료는 등록 대기입니다.'));
      return result;
    }
    for (const [title, selectors] of [
      ['소음별 주파수 분석', ['#noise-spectrum-artifact', '#noise-spectrum-summary', '#noise-analysis-parameters']],
      ['소음별 피크 분석', ['#noise-peaks-artifact', '#noise-peaks-table']],
      ['합성음원에서 피크 분석', ['#noise-mixture-caption', '#noise-mixture-artifact', '#noise-mixture-table', '#noise-mixture-note']],
      ['전처리 후보 요약', ['#noise-candidates-table']],
    ]) {
      result.append(element('h3', '', title));
      for (const selector of selectors) { const original = $(selector), copy = original.cloneNode(true); copy.querySelectorAll('canvas').forEach((canvas, index) => { const image = element('img'); image.src = original.querySelectorAll('canvas')[index].toDataURL('image/png'); image.alt = canvas.getAttribute('aria-label') || '분석 그래프'; canvas.replaceWith(image); }); copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(item => item.removeAttribute('id')); result.append(copy); }
    }
    return result;
  }
  return { initialize, load, render, report };
}
