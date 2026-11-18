import { normalizeCleanCollection, collectionMatches } from './collection-data.js';
import { readServerJSON } from './files.js';

const node = (tag, className = '', text = '') => { const result = document.createElement(tag); result.className = className; result.textContent = text; return result; };

export function createCleanLibrary({ fingerprints, stopAudio }) {
  let data = { version: 1, recordings: [] }, error = '';
  async function load() {
    try { data = normalizeCleanCollection(await readServerJSON('dataset/collection.json')); error = ''; }
    catch (failure) { data = { version: 1, recordings: [] }; error = '원음 목록을 불러오지 못했습니다. ' + failure.message; }
  }
  function render() {
    const connected = data.recordings.filter(row => collectionMatches(row, fingerprints())).length;
    const status = document.getElementById('collection-status');
    status.textContent = error || (data.recordings.length ? '작업 지시 6개 · 위험 경고 6개 · 원음 ' + connected + '/12개 연결. 각 음원에서 문장과 화자를 확인하고 재생하세요.' : '원음 목록을 불러오는 중입니다.');
    status.classList.toggle('error', Boolean(error));
    for (const category of ['instruction', 'warning']) {
      const rows = data.recordings.filter(row => row.category === category);
      document.getElementById(category + '-count').textContent = rows.length + '개 원음';
      document.getElementById(category + '-library').replaceChildren(...rows.map(recording => {
        const row = node('article', 'source-row clean-recording'), label = node('div', 'source-label');
        label.append(node('strong', '', recording.label), node('small', '', recording.speaker + ' · ' + recording.id + '.wav · ' + recording.duration_seconds.toFixed(2) + '초'));
        row.append(label, node('p', 'recording-text', recording.text));
        if (collectionMatches(recording, fingerprints())) {
          const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
          const url = new URL('../' + recording.path, location.href); url.searchParams.set('v', recording.sha256);
          audio.src = url.href; audio.setAttribute('aria-label', recording.label + ' · ' + recording.speaker + ' 재생');
          audio.addEventListener('play', () => stopAudio(audio));
          audio.addEventListener('error', () => { audio.replaceWith(node('p', 'form-feedback error', '음원을 재생할 수 없습니다. 새로고침 후 다시 확인하세요.')); });
          row.append(audio);
        } else row.append(node('p', 'microcopy', '음원 연결 확인 중'));
        return row;
      }));
    }
  }
  function report() {
    const result = node('div'), table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
    result.append(node('p', '', '작업 지시 6개 · 위험 경고 6개 · 화자 유채원·김도연'));
    for (const title of ['파일명', '분류', '화자', '문장']) header.append(node('th', '', title));
    head.append(header);
    for (const recording of data.recordings) {
      const row = node('tr');
      for (const value of [recording.id + '.wav', recording.label, recording.speaker, recording.text]) row.append(node('td', '', value));
      body.append(row);
    }
    table.append(head, body); result.append(table); return result;
  }
  return { load, render, report, recordings: () => data.recordings };
}
