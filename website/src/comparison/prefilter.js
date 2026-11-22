import { normalizeFixedPrefilter, fixedPrefilterInputsMatch } from './prefilter-fixed-data.js';
import { element as el, analysisTable, analysisPlayer } from './peak-analysis.js';
const $ = selector => document.querySelector(selector);
const noises = { single: '단일 소음', complex: '복합 소음', changing: '변화 소음' };
const number = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 5 });

export function createFixedPrefilter({ fingerprints, stopAudio }) {
  let data = null, error = '', snr = 20, renderKey = '';
  async function load() {
    data = null; error = ''; renderKey = '';
    try {
      const response = await fetch(new URL('../dataset/prefilter/results.json', location.href), { cache: 'no-store' });
      if (response.status === 404) return;
      if (!response.ok) throw Error('사전필터 적용 음원 목록을 읽지 못했습니다.');
      data = normalizeFixedPrefilter(await response.json());
    } catch (failure) { error = failure.message; }
  }
  function table(filtered, ready) {
    const table = el('table', 'mixture-matrix prefilter-audio-matrix'), head = el('thead'), heading = el('tr'), body = el('tbody');
    heading.append(el('th', '', '소음 / 음성'));
    for (const recording of data.recordings) {
      const cell = el('th', '', recording.id); cell.scope = 'col'; cell.title = recording.text;
      cell.append(el('small', '', recording.speaker)); heading.append(cell);
    }
    head.append(heading);
    for (const [noise, label] of Object.entries(noises)) {
      const row = el('tr'), title = el('th', '', label); title.scope = 'row'; row.append(title);
      for (const recording of data.recordings) {
        const condition = data.conditions.find(item => item.noise === noise && item.statement === recording.id && item.snr === snr);
        const cell = el('td');
        if (ready) {
          const player = analysisPlayer(filtered ? condition.output_path : condition.input_path,
            `${label} · ${recording.id} · 입력 SNR ${snr}dB · ${filtered ? '고정 EQ 적용' : '무처리'}`, stopAudio);
          player.querySelector('h3')?.remove(); cell.append(player);
        } else cell.append(el('span', 'muted', '음원 확인 대기'));
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body); return table;
  }
  function render() {
    const ready = fixedPrefilterInputsMatch(data, fingerprints());
    const key = `${data?.run_id}/${snr}/${ready}/${error}`;
    if (key === renderKey) return;
    stopAudio();
    renderKey = key;
    $('#prefilter-status').textContent = ready ? `고정 EQ 적용 ${data.actual_count} / ${data.planned_count}개` : error || (data ? '음원 지문이 달라 재생을 보류했습니다.' : '완료된 고정 EQ 처리 음원 등록 대기');
    $('#prefilter-status').classList.toggle('ready', ready);
    $('#prefilter-status').classList.toggle('pending', !ready);
    $('#prefilter-content').hidden = !data;
    if (!data) return;
    analysisTable($('#prefilter-fixed-settings'), ['필터', '중심주파수 fc (Hz)', '대역폭 BW (Hz)', 'Q', 'Gain (dB)'],
      data.settings.sections.map((section, index) => [`Peaking EQ ${index + 1}`, number(section.center_hz), number(section.bandwidth_hz), number(section.q), number(section.gain_db)]));
    $('#prefilter-snr').value = String(snr);
    $('#prefilter-table-note').textContent = `두 표 모두 입력 SNR ${snr}dB · 소음 3종 × 음성 12개. 같은 행·열의 무처리 음원과 고정 EQ 적용 음원이 대응합니다.`;
    $('#prefilter-original-matrix').replaceChildren(table(false, ready));
    $('#prefilter-filtered-matrix').replaceChildren(table(true, ready));
  }
  function initialize() {
    for (const value of [20, 10, 5, 0]) $('#prefilter-snr').add(new Option(value + ' dB', String(value)));
    $('#prefilter-snr').addEventListener('change', event => { snr = Number(event.target.value); stopAudio(); render(); });
  }
  function report() {
    const host = el('div');
    if (!data) { host.append(el('p', '', error || '고정 EQ 처리 결과 등록 대기')); return host; }
    host.append(el('p', '', `공통 고정형 Peaking EQ · ${data.actual_count}/${data.planned_count}개 처리 · 16kHz · 2차 EQ 두 개 직렬 연결`));
    const settings = el('div');
    analysisTable(settings, ['필터', '중심 (Hz)', 'BW (Hz)', 'Q', 'Gain (dB)'], data.settings.sections.map(s => [s.id, s.center_hz, s.bandwidth_hz, s.q, s.gain_db]));
    host.append(settings); return host;
  }
  return { load, render, initialize, report };
}
