import { normalizeMixtureSummary, mixtureSummaryMatches, normalizeSNRComparison, normalizePeakComparison } from './mixture-summary-data.js';
import { element as el, number as n, analysisTable, analysisFigure, peakRows } from './peak-analysis.js';

const labels = { single: '단일 소음', complex: '복합 소음', changing: '변화 소음' };
const $ = selector => document.querySelector(selector);

export function createMixtureSummary({ analysis, fingerprints }) {
  let data = null, error = '', noise = 'single', snr = 20, view = 'welch', generation = 0;
  let comparison = null, comparisonError = '';
  let peakComparison = null, peakError = '', comparisonView = 'psd';
  const ready = () => mixtureSummaryMatches(data, analysis(), fingerprints());

  async function load() {
    const token = ++generation;
    data = null; error = ''; comparison = null; comparisonError = ''; peakComparison = null; peakError = '';
    try {
      const response = await fetch(new URL('../dataset/mixture_summary/results.json', location.href), { cache: 'no-store' });
      if (response.status === 404) return;
      if (!response.ok) throw Error('평균 분석 결과를 읽지 못했습니다.');
      const loaded = normalizeMixtureSummary(await response.json());
      if (token !== generation) return;
      data = loaded;
      try {
        const response = await fetch(new URL('../dataset/mixture_summary/snr_comparison.json', location.href), { cache: 'no-store' });
        if (response.status !== 404) {
          if (!response.ok) throw Error('SNR 비교 그래프를 읽지 못했습니다.');
          const presentation = normalizeSNRComparison(await response.json(), loaded);
          if (token === generation) comparison = presentation;
        }
      } catch (failure) { if (token === generation) comparisonError = failure.message; }
      try {
        const response = await fetch(new URL('../dataset/mixture_summary/peak_comparison.json', location.href), { cache: 'no-store' });
        if (response.status !== 404) {
          if (!response.ok) throw Error('피크·안정성·Clean 비교 자료를 읽지 못했습니다.');
          const presentation = normalizePeakComparison(await response.json(), loaded);
          if (token === generation) peakComparison = presentation;
        }
      } catch (failure) { if (token === generation) peakError = failure.message; }
    } catch (failure) { if (token === generation) error = failure.message; }
  }

  function render() {
    const usable = ready(), status = $('#mixture-summary-status');
    document.querySelectorAll('[data-comparison-view]').forEach(button => {
      const active = button.dataset.comparisonView === comparisonView;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-comparison-panel]').forEach(panel => { panel.hidden = panel.dataset.comparisonPanel !== comparisonView; });
    const peakReady = usable && Boolean(peakComparison), peakStatus = $('#mixture-peak-comparison-status');
    peakStatus.hidden = comparisonView === 'psd';
    peakStatus.textContent = peakReady ? '12그룹 · Changing 전체·2.5초 전후 · 비교 그래프 9개' : peakError || error || '완료된 피크 비교 자료 등록 대기';
    peakStatus.classList.toggle('ready', peakReady); peakStatus.classList.toggle('pending', !peakReady);
    for (const kind of ['peaks', 'tracking', 'clean']) {
      $('#mixture-peak-comparison-' + kind).hidden = !peakReady;
      if (peakReady) for (const [noise, label] of Object.entries(labels)) analysisFigure($('#mixture-peak-comparison-' + kind + '-' + noise),
        peakComparison.graphs[noise + '/' + kind], peakComparison.artifacts, `${label} · SNR 0·5·10·20dB · ${kind}${noise === 'changing' ? ' · 전체·2.5초 전후' : ''}`, 'mixture_summary');
    }
    if (peakReady) {
      const periods = { whole: '전체', before: '2.5초 이전', after: '2.5초 이후' };
      analysisTable($('#mixture-peak-comparison-counts'), ['소음', 'SNR (dB)', '구간', 'Noise 피크', '주파수 (Hz)', 'Noise 측정 대역 (Hz)', 'Mixture 피크 검출', '추적 유효 문장', '평균 주파수 (Hz)', '평균 표준편차 (Hz)', '평균 출현율 (%)', 'Clean/추가 소음 (dB)'],
        peakComparison.groups.flatMap(group => group.peaks.map(p => [labels[group.noise], group.snr, periods[group.period], p.peak_id, n(p.frequency_hz), `${n(p.low_hz)}–${n(p.high_hz)}`, `${p.mixture_count}/12`, `${p.valid_tracks}/12`, n(p.mean_frequency_hz), n(p.mean_std_hz), n(p.mean_appearance_percent), n(p.clean_to_noise_db)])));
    }
    const comparisonReady = usable && Boolean(comparison), comparisonStatus = $('#mixture-snr-comparison-status');
    comparisonStatus.textContent = comparisonReady ? '3개 소음 · SNR 0·5·10·20dB' : comparisonError || error || (data && !usable ? '입력·원본 분석이 달라 비교 표시를 보류했습니다.' : '완료된 SNR 비교 그래프 등록 대기');
    comparisonStatus.classList.toggle('ready', comparisonReady); comparisonStatus.classList.toggle('pending', !comparisonReady);
    $('#mixture-snr-comparison-results').hidden = !comparisonReady;
    if (comparisonReady) {
      $('#mixture-snr-comparison-note').textContent = `각 선은 해당 SNR 그룹의 12문장 평균 Mixture PSD입니다. 주파수 0–8000Hz · 공통 Y축 ${n(comparison.y_range_db[0])}–${n(comparison.y_range_db[1])}dB/Hz · Clean 발화 구간 RMS 기준 정규화. 세 그래프에서 SNR별 색상과 선 모양이 같습니다.`;
      for (const [kind, label] of Object.entries(labels)) analysisFigure($('#mixture-snr-comparison-' + kind), comparison.graphs[kind], comparison.artifacts,
        `${label} · SNR 0·5·10·20dB · Mixture mean PSD`, 'mixture_summary');
    }
    status.textContent = usable ? `${labels[noise]} · ${snr}dB · 12문장 평균` : error || (data ? '입력·원본 분석이 달라 평균 표시를 보류했습니다.' : '완료된 평균 분석 자료 등록 대기');
    status.classList.toggle('ready', usable); status.classList.toggle('pending', !usable);
    $('#mixture-summary-results').hidden = !usable;
    $('#mixture-summary-noise').value = noise; $('#mixture-summary-snr').value = String(snr);
    document.querySelectorAll('[data-summary-view]').forEach(button => {
      const active = button.dataset.summaryView === view;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-summary-panel]').forEach(panel => { panel.hidden = panel.dataset.summaryPanel !== view; });
    if (!usable) return;
    const group = data.groups.find(row => row.noise === noise && row.snr === snr), signal = group.signals.mixture;
    $('#mixture-summary-caption').textContent = `${labels[noise]} · 입력 SNR ${snr}dB · 12문장(화자 2명) · 각 문장 동일 가중치`;
    $('#mixture-summary-normalization').textContent = '각 Clean 기준음의 등록 발화 시작–끝 구간 RMS를 1로 맞추고, 같은 배율을 합성음·실제 추가 소음에도 적용했습니다. 내부 쉼을 포함합니다. 그래프는 정규화 PSD(dB/Hz)이며, 아래 원본 재생의 음량과 개별 분석의 dBFS/Hz는 유지됩니다.';
    for (const key of ['welch', 'peaks', 'temporal']) analysisFigure($('#mixture-summary-' + key), group.graphs[key], data.artifacts,
      `${labels[noise]} · ${snr}dB · 12문장 평균 · ${key}`, 'mixture_summary');
    $('#mixture-summary-welch-note').textContent = '문장별 선형 PSD를 평균한 뒤 dB로 표시했습니다. 선은 합성음·Clean·실제 추가 소음의 평균, 음영은 합성음 12문장의 최솟값–최댓값입니다. 문장별 전체 구간 PSD를 동일 가중치로 평균했습니다.';
    analysisTable($('#mixture-summary-peak-table'), ['평균 피크', '중심 (Hz)', '측정 폭 (Hz)', '정규화 PSD (dB/Hz)', '돌출도 (dB)', '문장별 대응 검출'],
      peakRows(signal.peaks).map((row, i) => [...row, `${signal.peak_counts[i]} / 12`]));
    const noiseComparison = group.signals.added_noise.noise_comparison;
    analysisTable($('#mixture-summary-noise-comparison'), ['원본 Noise 피크', '중심 / 측정 폭 (Hz)', '평균 Mixture 대응 중심 (Hz)', 'Mixture 검출 문장', 'Clean 검출 문장', '실제 추가 소음 검출 문장'],
      signal.noise_comparison.map((row, i) => [row.peak_id, `${n(row.frequency_hz)} / ${n(row.width_hz)}`, n(row.mean_peak_hz),
        `${row.matched_count} / 12`, `${group.signals.speech.noise_comparison[i].matched_count} / 12`, `${noiseComparison[i].matched_count} / 12`]));
    $('#mixture-summary-peak-note').textContent = `평균 합성음 PSD에서 돌출도 ${n(data.method.prominence_db)}dB·최소 간격 ${n(data.method.minimum_distance_bins)}bin 기준으로 최대 8피크를 검출했습니다. 문장별 대응 검출은 각 문장의 모든 조건 충족 피크를 대상으로 합니다. 원본 Noise 피크는 주파수·측정 대역의 기준이며, 원본의 절대 PSD를 정규화 PSD와 직접 비교하지 않습니다. Clean 피크 미검출은 음성 에너지 부재를 뜻하지 않습니다.`;
    $('#mixture-summary-temporal-note').textContent = '녹음 시작 0초에 맞춘 평균 STFT와 원본 Noise 피크 주변의 시점별 검출 비율·주파수 범위입니다. 각 시점에 완전한 프레임이 있는 음원만 평균하며, 끝난 음원을 무음으로 채우지 않습니다. 아래 그래프에 시점별 참여 수를 표시합니다. 범위 표시는 여러 문장의 독립 검출값이며 하나의 피크 궤적이 아닙니다.';
    analysisTable($('#mixture-summary-participants'), ['프레임 중심 시각 (초)', '평균 참여 음원'], group.times_sec.map((time, i) => [n(time), `${group.participant_counts[i]} / 12`]));
    analysisTable($('#mixture-summary-members'), ['문장', '등록 RMS 구간 (초)', 'Clean RMS', '분석 정규화 배율', '실제 SNR (dB)'],
      group.members.map(member => [member.id, `${n(member.start_sample / 16000)}–${n(member.end_sample / 16000)}`, member.clean_rms.toPrecision(5), n(member.normalization_gain), n(member.actual_snr_db)]));
    $('#mixture-summary-change-section').hidden = !group.split_sec;
    if (group.split_sec) {
      analysisFigure($('#mixture-summary-change'), group.graphs.change, data.artifacts, `${labels[noise]} · ${snr}dB · 2.5초 전후 평균`, 'mixture_summary');
      analysisTable($('#mixture-summary-change-table'), ['원본 Noise 피크', '중심 (Hz)', 'Mixture 대역 증감 (dB)', '실제 추가 소음 대역 증감 (dB)'],
        signal.noise_comparison.map((row, i) => [row.peak_id, n(row.frequency_hz), n(row.time_change_db), n(noiseComparison[i].time_change_db)]));
    }
  }

  function initialize() {
    document.querySelectorAll('[data-comparison-view]').forEach(button => button.addEventListener('click', () => { comparisonView = button.dataset.comparisonView; render(); }));
    for (const [key, label] of Object.entries(labels)) $('#mixture-summary-noise').add(new Option(label, key));
    for (const value of [20, 10, 5, 0]) $('#mixture-summary-snr').add(new Option(value + ' dB', String(value)));
    $('#mixture-summary-noise').addEventListener('change', event => { noise = event.target.value; render(); });
    $('#mixture-summary-snr').addEventListener('change', event => { snr = Number(event.target.value); render(); });
    document.querySelectorAll('[data-summary-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.summaryView; render(); }));
  }

  function report() {
    const result = el('div');
    result.append(el('h3', '', '소음별 SNR 비교 · Mixture mean PSD'));
    if (ready() && comparison) for (const selector of ['#mixture-snr-comparison-note', '#mixture-snr-comparison-single', '#mixture-snr-comparison-complex', '#mixture-snr-comparison-changing']) {
      const copy = $(selector).cloneNode(true); copy.removeAttribute('id');
      copy.querySelectorAll('a.button').forEach(item => item.remove()); result.append(copy);
    }
    else result.append(el('p', '', $('#mixture-snr-comparison-status').textContent));
    if (ready() && peakComparison) for (const kind of ['peaks', 'tracking', 'clean']) {
      result.append(el('h3', '', { peaks: 'Peak Detection 집계', tracking: 'Peak Tracking 안정성', clean: 'Clean 음성 중첩' }[kind]));
      const note = $('#mixture-peak-comparison-' + kind + '-note').cloneNode(true); note.removeAttribute('id'); result.append(note);
      for (const noise of Object.keys(labels)) {
        const copy = $('#mixture-peak-comparison-' + kind + '-' + noise).cloneNode(true); copy.removeAttribute('id');
        copy.querySelectorAll('a.button').forEach(item => item.remove()); result.append(copy);
      }
    }
    result.append(el('h3', '', 'Mixture 평균 분석 · ' + labels[noise] + ' · ' + snr + 'dB'));
    if (!ready()) { result.append(el('p', '', $('#mixture-summary-status').textContent)); return result; }
    for (const selector of ['#mixture-summary-caption', '#mixture-summary-normalization', '#mixture-summary-welch-note', '#mixture-summary-welch', '#mixture-summary-peak-note', '#mixture-summary-peaks', '#mixture-summary-peak-table', '#mixture-summary-noise-comparison', '#mixture-summary-temporal-note', '#mixture-summary-temporal', ...(noise === 'changing' ? ['#mixture-summary-change-section'] : [])]) {
      const copy = $(selector).cloneNode(true); copy.removeAttribute('id'); copy.hidden = false;
      copy.querySelectorAll('[id]').forEach(item => item.removeAttribute('id')); copy.querySelectorAll('a.button').forEach(item => item.remove());
      result.append(copy);
    }
    return result;
  }
  return { initialize, load, render, report };
}
