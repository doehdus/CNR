import { normalizeBpfPrefilter, bpfPrefilterInputsMatch } from './prefilter-bpf-data.js';
import { element as el } from './peak-analysis.js';
const $ = selector => document.querySelector(selector);
const noises = { single: '단일 소음', complex: '복합 소음', changing: '변화 소음' };
const kinds = { original: '무처리 합성음원', filtered: 'Butterworth 처리 합성음원' };
const snrs = [20, 10, 5, 0];

export function createBpfPrefilter({ fingerprints, stopAudio }) {
  let data = null, error = '', renderKey = '', kind = 'original', snr = 20, selected = null;
  let cells = [];
  const kindButtons = [];
  const snrButtons = [];
  async function load() {
    data = null; error = ''; renderKey = '';
    try {
      const response = await fetch(new URL('../dataset/prefilter_bpf/results.json', location.href), { cache: 'no-store' });
      if (response.status === 404) return;
      if (!response.ok) throw Error('사전필터링 음원 목록을 읽지 못했습니다.');
      data = normalizeBpfPrefilter(await response.json());
    } catch (failure) { error = failure.message; }
  }
  function matrix(ready) {
    const table = el('table', 'condition-matrix prefilter-playback-matrix');
    const head = el('thead'), heading = el('tr'), body = el('tbody');
    table.append(el('caption', 'sr-only', kinds[kind] + ' · 입력 SNR ' + snr + 'dB · 음원 12행, 소음 3열'));
    const columns = el('colgroup');
    columns.append(el('col', 'prefilter-recording-column'));
    for (const _noise of Object.keys(noises)) columns.append(el('col', 'prefilter-noise-column'));
    table.append(columns);
    for (const text of ['음원', ...Object.values(noises)]) {
      const th = el('th', '', text); th.scope = 'col'; heading.append(th);
    }
    head.append(heading); cells = [];
    for (const recording of data.recordings) {
      const tr = el('tr'), th = el('th', 'prefilter-recording');
      th.scope = 'row';
      th.append(el('strong', '', (recording.category === 'warning' ? '위험 경고 ' : '작업 지시 ') + recording.id.slice(-2)),
        el('span', 'prefilter-speaker', recording.speaker),
        el('small', 'prefilter-sentence', recording.text));
      tr.append(th);
      for (const [noise, noiseLabel] of Object.entries(noises)) {
        const row = data.conditions.find(r => r.noise === noise && r.snr === snr && r.statement === recording.id);
        const cell = el('td'), button = el('button', 'matrix-button', ready ? '재생' : '연결 대기');
        const path = kind === 'filtered' ? row.output_path : row.input_path;
        const label = kinds[kind] + ' · ' + recording.text + ' · ' + noiseLabel + ' · 입력 SNR ' + snr + 'dB';
        const message = el('span', 'prefilter-cell-error', '음원을 재생하지 못했습니다.');
        message.hidden = true;
        button.type = 'button'; button.disabled = !ready;
        button.dataset.statement = row.statement; button.dataset.noise = noise; button.dataset.audioPath = path;
        button.setAttribute('aria-label', label + ' 재생'); button.setAttribute('aria-pressed', 'false');
        cell.classList.toggle('selected-condition', selected?.noise === noise && selected?.statement === recording.id);
        cell.append(button, message); cells.push({ cell, noise, statement: recording.id });
        if (ready) {
          const audio = el('audio'); audio.hidden = true; audio.preload = 'none';
          audio.src = new URL('../dataset/audio/' + path, location.href).href;
          const playing = value => {
            button.textContent = value ? '일시정지' : '재생';
            button.setAttribute('aria-label', label + (value ? ' 일시정지' : ' 재생'));
            button.setAttribute('aria-pressed', String(value));
            cell.classList.toggle('is-playing', value);
          };
          audio.addEventListener('play', () => {
            stopAudio(audio); message.hidden = true; playing(true);
            selected = { noise, statement: recording.id };
            for (const entry of cells) entry.cell.classList.toggle('selected-condition', entry.noise === noise && entry.statement === recording.id);
            $('#prefilter-playback-status').textContent = noiseLabel + ' · ' + recording.id + ' · 입력 SNR ' + snr + 'dB 재생 중';
          });
          audio.addEventListener('pause', () => playing(false));
          audio.addEventListener('ended', () => {
            playing(false); $('#prefilter-playback-status').textContent = recording.id + ' 재생 완료';
          });
          audio.addEventListener('error', () => { playing(false); message.hidden = false; });
          button.addEventListener('click', () => {
            if (!audio.paused) { audio.pause(); $('#prefilter-playback-status').textContent = recording.id + ' 일시정지'; return; }
            stopAudio(audio);
            try { Promise.resolve(audio.play()).catch(() => { playing(false); message.hidden = false; }); }
            catch { message.hidden = false; }
          });
          cell.append(audio);
        }
        tr.append(cell);
      }
      body.append(tr);
    }
    table.append(head, body); return table;
  }
  function render() {
    const ready = bpfPrefilterInputsMatch(data, fingerprints());
    const key = [data?.run_id, kind, snr, ready, error].join('|');
    if (key === renderKey) return;
    renderKey = key; stopAudio();
    $('#prefilter-status').textContent = ready ? '144조건 연결 완료' : error || (data ? '음원 지문이 달라 재생을 보류했습니다.' : '완료된 음원 등록 대기');
    $('#prefilter-status').classList.toggle('ready', ready); $('#prefilter-status').classList.toggle('pending', !ready);
    $('#prefilter-content').hidden = !data;
    if (!data) return;
    for (const button of kindButtons) {
      const active = button.dataset.prefilterKind === kind;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    for (const button of snrButtons) {
      const active = Number(button.dataset.snr) === snr;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    $('#prefilter-matrix-title').textContent = kinds[kind];
    $('#prefilter-table-note').textContent = '입력 SNR ' + snr + 'dB · 음원 12개 × 소음 3종';
    $('#prefilter-playback-status').textContent = ready ? '표의 재생 버튼을 누르면 들을 수 있습니다.' : '음원 확인 대기';
    $('#prefilter-matrix').replaceChildren(matrix(ready));
  }
  function initialize() {
    for (const [value, label] of Object.entries(kinds)) {
      const button = el('button', 'prefilter-kind-button', label);
      button.type = 'button'; button.dataset.prefilterKind = value;
      button.addEventListener('click', () => { if (kind !== value) { kind = value; render(); } });
      kindButtons.push(button); $('#prefilter-kind-options').append(button);
    }
    for (const value of snrs) {
      const button = el('button', 'prefilter-snr-button', value + ' dB');
      button.type = 'button'; button.dataset.snr = String(value);
      button.addEventListener('click', () => { if (snr !== value) { snr = value; render(); } });
      snrButtons.push(button); $('#prefilter-snr-options').append(button);
    }
  }
  function report() {
    const host = el('div');
    host.append(el('p', '', data ? '사전필터링 재생 자료 · 무처리 원본 / Butterworth 처리 · 각 144조건 · 처리음에만 저장 여유 −1dB 포함' : '사전필터링 음원 등록 대기'));
    return host;
  }
  return { load, render, initialize, report };
}
