import { normalizePeakAnalysis, normalizePeakDetails, peakInputsMatch } from './peak-analysis-data.js';
import { createMixtureSummary } from './mixture-summary.js';
import { element as el, number as n, assetURL, analysisTable, analysisFigure, analysisPlayer, peakRows, renderNoisePeaks, renderTracking } from './peak-analysis.js';

const $ = selector => document.querySelector(selector);
const labels = { single: '단일 소음', complex: '복합 소음', changing: '변화 소음' };
const peakHeadings = ['피크', '중심 주파수 (Hz)', '측정 폭 (Hz)', 'PSD (dBFS/Hz)', '돌출도 (dB)'];

export function createNoiseAnalysis({ fingerprints, stopAudio }) {
  let data = null, error = '', noise = 'single', mixtureNoise = 'single', statement = 'instruction01', snr = 20;
  let noiseView = 'welch', mixtureView = 'welch', request = 0;
  let playerKey = '', comparisonKey = '', activePage = '';
  const details = new Map();
  const summaryPage = createMixtureSummary({ analysis: () => data, fingerprints });
  const ready = () => Boolean(data?.engine?.language === 'C') && peakInputsMatch(data, fingerprints());
  const selectedSource = () => data?.sources.find(row => row.noise === noise);
  const selectedMixture = () => data?.conditions.find(row => row.noise === mixtureNoise && row.statement === statement && row.snr === snr);

  function syncNoiseSelection() {
    const value = $('#noise-analysis-source').value;
    if (!Object.hasOwn(labels, value) || value === noise) return false;
    noise = value;
    request++;
    return true;
  }

  async function load() {
    request++; data = null; error = ''; details.clear();
    comparisonKey = playerKey = '';
    try {
      const response = await fetch(new URL('../dataset/peak_analysis/results.json', location.href), { cache: 'no-store' });
      if (response.status === 404) return;
      if (!response.ok) throw Error('완료된 C 분석 결과를 읽지 못했습니다.');
      data = normalizePeakAnalysis(await response.json());
    } catch (failure) { data = null; error = failure.message; }
    await summaryPage.load();
  }

  async function readDetails(row) {
    if (details.has(row.details)) return details.get(row.details);
    const job = (async () => {
      const response = await fetch(assetURL(row.details), { cache: 'no-cache' });
      if (!response.ok) throw Error('추적 결과 파일을 읽지 못했습니다.');
      const buffer = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== data.artifacts[row.details]) throw Error('추적 결과의 파일 지문이 다릅니다.');
      const result = normalizePeakDetails(JSON.parse(new TextDecoder().decode(buffer)), data.engine.run_id);
      return result;
    })();
    details.set(row.details, job);
    try { return await job; } catch (failure) { details.delete(row.details); throw failure; }
  }

  function setPanels() {
    document.querySelectorAll('[data-acoustic-panel]').forEach(panel => {
      const [kind, view] = panel.dataset.acousticPanel.split(':');
      panel.hidden = view !== (kind === 'noise' ? noiseView : mixtureView);
    });
    document.querySelectorAll('[data-acoustic-view]').forEach(link => {
      const [kind, view] = link.dataset.acousticView.split(':');
      const active = view === (kind === 'noise' ? noiseView : mixtureView);
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }

  function figures(row, kind) {
    for (const key of ['welch', 'peaks', 'temporal']) analysisFigure($('#' + kind + '-c-' + key), row.graphs[key], data.artifacts,
      `${kind === 'noise' ? labels[noise] : labels[mixtureNoise] + ' · ' + statement + ' · ' + snr + 'dB'} · ${key === 'temporal' ? 'Spectrogram + Peak Tracking' : key === 'peaks' ? 'Peak Detection' : 'Welch PSD'}`);
  }

  function renderNoise() {
    // Browsers can restore a select without dispatching a change event.
    syncNoiseSelection();
    const source = selectedSource();
    $('#noise-analysis-status').textContent = `${labels[noise]} · C 계산 완료 · 저장 결과 조회`;
    const { sample_rate_hz: rate, nperseg: samples, noverlap: overlap } = data.method;
    const hop = samples - overlap;
    $('#noise-c-welch-conditions').textContent = `분석 조건: 선택한 소음 원본 전체 · ${n(rate / 1000)}kHz · Hann ${n(samples)}샘플(${n(samples / rate * 1000)}ms) · ${n(hop)}샘플 이동(${n(hop / rate * 1000)}ms, ${n(overlap / samples * 100)}% 중첩) · 프레임별 평균 제거. 완전한 프레임의 선형 PSD를 평균한 뒤 dBFS/Hz로 표시합니다.`;
    const frameSteps = `소음 WAV(${n(rate / 1000)}kHz) → 프레임 분할(${n(samples)}샘플, ${n(hop)}샘플 이동) → 프레임 평균 제거 → Hann 창 적용`;
    const { minimum_distance_bins: distance, prominence_db: prominence, max_source_peaks: maximum,
      matching_minimum_bins: matchingBins, matching_width_fraction: matchingWidth } = data.method;
    $('#noise-c-peak-conditions').textContent = `분석 순서: ${frameSteps} → FFT → 단측 PSD 계산 → 선형 PSD 평균(Welch) → 국소 최댓값 탐색 → 최소 간격 ${n(distance)}bin 적용 → 돌출도 ${n(prominence)}dB 이상 선별 → 선형 PSD의 half-prominence 폭 측정 → PSD 크기순 최대 ${n(maximum)}개 표시.`;
    $('#noise-c-temporal-conditions').textContent = `분석 순서: ${frameSteps} → 프레임별 FFT(STFT) → 단측 PSD 계산·스펙트로그램 표시 → 프레임별 피크 검출(최소 간격 ${n(distance)}bin·돌출도 ${n(prominence)}dB 이상인 모든 피크) → 인접 프레임의 피크를 주파수 차이가 작은 순서로 일대일 연결(허용 범위 max(${n(matchingBins)}bin, 이전 피크 폭 × ${n(matchingWidth)}), 끊기면 새 궤적) → 궤적별 평균 주파수·모집단 표준편차·출현율(전체 프레임 기준) 계산.`;
    for (const view of ['welch', 'peak', 'temporal']) {
      const caption = $('#noise-c-' + view + '-conditions');
      caption.textContent = labels[noise] + ' · ' + caption.textContent;
    }
    figures(source, 'noise');
    analysisTable($('#noise-c-energy'), ['대역 (Hz)', '에너지 비율 (%)'], source.band_energy.map(band => [`${band.low_hz}–${band.high_hz}`, n(band.energy_percent)]));
    renderNoisePeaks($('#noise-c-peak-table'), source, data.frequency_hz);
    const select = $('#noise-c-zoom-select'), selected = select.value;
    select.replaceChildren(...source.peaks.map(peak => new Option(`${peak.id} · ${n(peak.frequency_hz)} Hz`, peak.id)));
    select.disabled = !source.peaks.length;
    select.value = source.peaks.some(peak => peak.id === selected) ? selected : source.peaks[0]?.id || '';
    renderZoom();
    $('#noise-c-source-note').textContent = `${labels[noise]} · 16kHz · Hann 2048샘플 · 1024샘플 이동. 전체 프레임의 평균 PSD와 시간별 궤적을 구분합니다.`;
    if (activePage === 'noise-analysis' && noiseView === 'temporal') loadNoiseTracking(source);
  }

  function renderZoom() {
    if (!ready()) return;
    const source = selectedSource(), id = $('#noise-c-zoom-select').value;
    analysisFigure($('#noise-c-zoom'), source.graphs['zoom_' + id], data.artifacts, `${labels[noise]} · ${id} 주변 확대`);
  }

  async function loadNoiseTracking(source) {
    const token = request, key = source.details;
    $('#noise-c-tracking').replaceChildren(el('p', 'analysis-help', '완료된 추적 결과를 읽고 있습니다.'));
    try {
      const loaded = await readDetails(source);
      if (request !== token || selectedSource()?.details !== key || !ready()) return;
      renderTracking($('#noise-c-tracking'), loaded.signal);
    } catch (failure) { if (request === token && selectedSource()?.details === key) $('#noise-c-tracking').replaceChildren(el('p', 'audio-error', failure.message)); }
  }

  function renderMatrix() {
    const table = el('table', 'mixture-matrix'), head = el('thead'), row = el('tr'), body = el('tbody');
    row.append(el('th', '', '소음 / 음성'));
    for (const recording of data.recordings) { const cell = el('th', '', recording.id); cell.scope = 'col'; cell.title = recording.text + ' · ' + recording.speaker; row.append(cell); }
    head.append(row);
    for (const kind of ['single', 'complex', 'changing']) {
      const line = el('tr'), heading = el('th', '', labels[kind]); heading.scope = 'row'; line.append(heading);
      for (const recording of data.recordings) {
        const cell = el('td'), selected = kind === mixtureNoise && recording.id === statement;
        cell.classList.toggle('selected', selected);
        for (const [action, text] of [['play', '재생'], ['select', '분석']]) {
          const button = el('button', 'matrix-action', text); button.type = 'button';
          button.dataset.matrixAction = action; button.dataset.noise = kind; button.dataset.statement = recording.id;
          button.setAttribute('aria-label', `${labels[kind]} ${recording.id} ${snr}dB ${text}`);
          if (action === 'select') button.setAttribute('aria-pressed', String(selected));
          cell.append(button);
        }
        line.append(cell);
      }
      body.append(line);
    }
    table.append(head, body); $('#mixture-c-matrix').replaceChildren(table);
  }

  function renderMixture() {
    const row = selectedMixture(), recording = data.recordings.find(item => item.id === statement);
    const method = data.method, hop = method.nperseg - method.noverlap;
    const frames = `프레임 분할(${n(method.nperseg)}샘플, ${n(hop)}샘플 이동) → 프레임 평균 제거 → Hann 창 적용`;
    const detection = `국소 최댓값 탐색 → 최소 간격 ${n(method.minimum_distance_bins)}bin 적용 → 돌출도 ${n(method.prominence_db)}dB 이상 선별`;
    $('#mixture-c-welch-conditions').textContent = `분석 순서: 혼합음·대응 기준음(${n(method.sample_rate_hz / 1000)}kHz) 로드 → 혼합음−기준음으로 실제 추가 소음 분리 → 각 신호의 ${frames} → FFT → 단측 PSD 계산 → 프레임별 선형 PSD 평균(Welch) → dBFS/Hz 변환 → 같은 축으로 비교.`;
    $('#mixture-c-peak-conditions').textContent = `분석 순서: 혼합음 → ${frames} → FFT → 단측 PSD 계산 → 선형 PSD 평균(Welch) → ${detection} → 선형 PSD의 half-prominence 폭 측정 → PSD 크기순 최대 ${n(method.max_source_peaks)}개 표시.`;
    $('#mixture-c-temporal-conditions').textContent = `분석 순서: 혼합음 → ${frames} → 프레임별 FFT(STFT) → 단측 PSD 계산·스펙트로그램 표시 → 프레임별 피크 검출(${n(method.minimum_distance_bins)}bin 이상 간격·돌출도 ${n(method.prominence_db)}dB 이상인 모든 피크) → 인접 프레임의 피크를 가까운 주파수부터 일대일 연결(허용 범위 max(${n(method.matching_minimum_bins)}bin, 이전 피크 폭 × ${n(method.matching_width_fraction)}), 끊기면 새 궤적) → 전체 구간의 궤적별 평균 주파수·모집단 표준편차·출현율 계산.`;
    figures(row, 'mixture');
    $('#mixture-c-caption').textContent = `${labels[mixtureNoise]} · ${statement} · ${recording.speaker} · SNR ${snr}dB`;
    $('#mixture-c-sentence').textContent = recording.text;
    $('#mixture-c-interval').textContent = `등록된 말소리 구간 ${n(row.interval_sec[0])}–${n(row.interval_sec[1])}초 · 내부 쉼 포함 · 실제 SNR ${n(row.actual_snr_db)}dB`;
    analysisTable($('#mixture-c-peak-table'), peakHeadings, peakRows(row.mixture_peaks));
    const key = `${mixtureNoise}/${snr}/${statement}`;
    if (key !== playerKey) {
      $('#mixture-c-players').replaceChildren(
        analysisPlayer(`data/reference/${statement}.wav`, '합성과 대응하는 기준음', stopAudio),
        analysisPlayer(`data/mixed/${mixtureNoise}/snr${String(snr).padStart(2, '0')}/${statement}.wav`, '선택한 무처리 합성음', stopAudio));
      playerKey = key;
    }
    if (activePage === 'mixture-analysis' && mixtureView === 'temporal') loadMixtureTracking(row);
  }

  async function loadMixtureTracking(row) {
    const token = request, key = row.details;
    $('#mixture-c-tracking').replaceChildren(el('p', 'analysis-help', '완료된 추적 결과를 읽고 있습니다.'));
    try {
      const loaded = await readDetails(row);
      if (request !== token || selectedMixture()?.details !== key || !ready()) return;
      renderTracking($('#mixture-c-tracking'), loaded.signal);
    } catch (failure) {
      if (request === token && selectedMixture()?.details === key) $('#mixture-c-tracking').replaceChildren(el('p', 'audio-error', failure.message));
    }
  }

  function renderComparison() {
    const row = selectedMixture(), source = data.sources.find(item => item.noise === mixtureNoise);
    if (comparisonKey !== row.details) for (const id of ['mixture-c-comparison', 'mixture-c-tracks']) $('#' + id).replaceChildren(el('p', 'analysis-help', '선택 조건의 비교 자료를 읽고 있습니다.'));
    if (activePage === 'mixture-analysis') loadComparison(row, source);
  }

  async function loadComparison(row, source = data.sources.find(item => item.noise === row.noise)) {
    const token = request, key = row.details;
    try {
      const [loaded, original] = await Promise.all([readDetails(row), readDetails(source)]);
      if (request !== token || selectedMixture()?.details !== key || !ready()) return;
      const track = (signal, id) => signal.tracking.tracks.find(item => item.id === id);
      const summary = value => value ? `${n(value.mean_hz)} Hz\nσ ${n(value.std_hz)} Hz · ${n(value.appearance_percent)}%` : '대응 궤적 없음';
      analysisTable($('#mixture-c-comparison'), ['Noise 피크', 'Noise 중심 / 측정 폭 (Hz)', 'Mixture 중심 / 측정 폭 (Hz)', '기준음 국소 피크', '측정 폭 안의 기준음/추가소음 (dB)'],
        row.observations.map((observation, index) => {
          const peak = source.peaks[index];
          return [peak.id, `${n(peak.frequency_hz)} / ${n(peak.bandwidth_hz)}`, `${n(observation.mixture_frequency_hz)} / ${n(observation.mixture_width_hz)}`,
            observation.speech_peak_present ? '검출' : '미검출', n(observation.speech_to_noise_db)];
        }));
      analysisTable($('#mixture-c-tracks'), ['Noise 피크', '원본 Noise · 평균 / 표준편차 / 출현율', '실제 추가 소음 · 평균 / 표준편차 / 출현율', 'Mixture · 평균 / 표준편차 / 출현율'],
        row.observations.map((observation, index) => [source.peaks[index].id,
          summary(track(original.signal, original.signal.tracking.peak_track_ids[index])),
          summary(track(loaded.added_noise, observation.noise_track_id)), summary(track(loaded.signal, observation.mixture_track_id))]));
      comparisonKey = key;
    } catch (failure) {
      if (request === token && selectedMixture()?.details === key) for (const id of ['mixture-c-comparison', 'mixture-c-tracks']) $('#' + id).replaceChildren(el('p', 'audio-error', failure.message));
    }
  }

  function render() {
    summaryPage.render();
    setPanels();
    const usable = ready();
    const message = error || (data && !peakInputsMatch(data, fingerprints()) ? '입력 음원 지문이 달라 이전 분석 표시를 보류했습니다.' : '완료된 C 분석 자료 등록 대기');
    for (const kind of ['noise', 'mixture']) {
      $('#' + kind + '-analysis-status').textContent = usable ? 'C 계산 완료 · 저장 결과 조회' : message;
      $('#' + kind + '-analysis-status').classList.toggle('ready', usable);
      $('#' + kind + '-analysis-status').classList.toggle('pending', !usable);
      document.querySelectorAll('[data-c-ready="' + kind + '"]').forEach(host => { host.hidden = !usable; });
    }
    if (!usable) return;
    if (!$('#noise-c-library').children.length || $('#noise-c-library').dataset.run !== data.engine.run_id) {
      $('#noise-c-library').replaceChildren(...Object.keys(labels).map(kind => analysisPlayer(`data/noise/${kind}.wav`, labels[kind], stopAudio)));
      $('#noise-c-library').dataset.run = data.engine.run_id;
    }
    renderNoise(); renderMatrix(); renderMixture(); renderComparison();
  }

  function navigate(page, view) {
    activePage = page;
    if (page === 'noise-analysis') noiseView = ['welch', 'peaks', 'temporal'].includes(view) ? view : noiseView;
    if (page === 'mixture-analysis') mixtureView = ['welch', 'peaks', 'temporal'].includes(view) ? view : mixtureView;
    setPanels();
    if (ready()) { if (page === 'noise-analysis') renderNoise(); if (page === 'mixture-analysis') renderMixture(); if (page === 'mixture-analysis') renderComparison(); }
  }

  function initialize() {
    summaryPage.initialize();
    const refreshNoise = () => {
      if (!syncNoiseSelection()) return;
      stopAudio();
      render();
    };
    for (const event of ['input', 'change']) $('#noise-analysis-source').addEventListener(event, refreshNoise);
    window.addEventListener('pageshow', () => { syncNoiseSelection(); render(); });
    for (const value of [20, 10, 5, 0]) $('#mixture-analysis-snr').add(new Option(value + ' dB', String(value)));
    $('#mixture-analysis-snr').addEventListener('change', event => { snr = Number(event.target.value); request++; stopAudio(); renderMatrix(); renderMixture(); renderComparison(); });
    $('#noise-c-zoom-select').addEventListener('change', renderZoom);
    $('#mixture-c-matrix').addEventListener('click', event => {
      const button = event.target.closest('[data-matrix-action]'); if (!button || !ready()) return;
      mixtureNoise = button.dataset.noise; statement = button.dataset.statement; request++; stopAudio();
      renderMatrix(); renderMixture(); renderComparison();
      if (button.dataset.matrixAction === 'play') $('#mixture-c-players').querySelectorAll('audio')[1]?.play().catch(() => {});
    });
  }

  async function report() {
    const result = el('div', 'noise-analysis-report');
    result.append(summaryPage.report());
    if (!ready()) { result.append(el('p', '', error || '현재 입력과 대응하는 완료 C 분석 자료가 없습니다.')); return result; }
    const token = request;
    await Promise.all([loadNoiseTracking(selectedSource()), loadMixtureTracking(selectedMixture()), loadComparison(selectedMixture(), data.sources.find(item => item.noise === mixtureNoise))]);
    if (request !== token || !ready()) throw Error('보고서 구성 중 조건이 바뀌었습니다. 다시 인쇄해 주세요.');
    for (const [title, selectors] of [['Noise 분석 · ' + labels[noise], ['#noise-c-welch-conditions', '#noise-c-welch', '#noise-c-energy', '#noise-c-peak-conditions', '#noise-c-peak-table', '#noise-c-temporal-conditions', '#noise-c-temporal', '#noise-c-tracking']],
      ['Mixture 분석 · ' + statement + ' · ' + snr + 'dB', ['#mixture-c-caption', '#mixture-c-welch-conditions', '#mixture-c-welch', '#mixture-c-peak-conditions', '#mixture-c-peak-table', '#mixture-c-temporal-conditions', '#mixture-c-temporal', '#mixture-c-tracking', '#mixture-c-comparison', '#mixture-c-tracks']]]) {
      result.append(el('h3', '', title));
      for (const selector of selectors) {
        const copy = $(selector).cloneNode(true); copy.removeAttribute('id');
        copy.querySelectorAll('[id]').forEach(item => item.removeAttribute('id')); copy.querySelectorAll('button, audio').forEach(item => item.remove()); result.append(copy);
      }
    }
    return result;
  }
  return { initialize, load, render, navigate, report };
}
