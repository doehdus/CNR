import { $, element, api, storedValue, showMessage } from './survey-common.js';
import { EVALUATION_SAMPLES, EVALUATION_METHODS, NOISES, SNRS, STATEMENTS, SAMPLE_INDEX, normalizeManifest, algorithmLabel } from './dataset.js';
import qrcode from '../vendor/qrcode.mjs';

const phases = { waiting: '참가자 접속 대기', listening: '음원 청취', answering: '응답 접수 중', closed: '종료' };
let candidates = [], selected = [], active = null, controlToken = null, busy = false, audioId = null, qrSVG = '';
let pendingCreation = null;
const code = new URLSearchParams(location.search).get('session');

function sampleLabel(sample) { return STATEMENTS.find(statement => statement.id === sample.statement).label; }
function compareSelectionSamples(a, b) {
  return STATEMENTS.findIndex(row => row.id === a.statement) - STATEMENTS.findIndex(row => row.id === b.statement)
    || NOISES.findIndex(row => row.id === a.noise) - NOISES.findIndex(row => row.id === b.noise)
    || EVALUATION_METHODS.findIndex(row => row.id === a.algorithm) - EVALUATION_METHODS.findIndex(row => row.id === b.algorithm)
    || a.snr - b.snr;
}
function visibleSamples() {
  return candidates.filter(sample => [['algorithm', '#select-algorithm'], ['noise', '#select-noise'], ['snr', '#select-snr']].every(([key, selector]) => $(selector).value === 'all' || String(sample[key]) === $(selector).value));
}

function renderSelection() {
  $('#selected-count').textContent = '선택 ' + selected.length + '개 · 연결된 평가 음원 ' + candidates.length + '개';
  $('#create-button').disabled = busy || !selected.length;
  $('#audio-choices').replaceChildren(...visibleSamples().map(sample => {
    const row = element('tr'), cell = element('td'), label = element('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.includes(sample.id);
    checkbox.setAttribute('aria-label', sampleLabel(sample) + ' ' + sample.noise + ' ' + sample.snr + ' dB ' + algorithmLabel(sample.algorithm));
    checkbox.addEventListener('change', () => {
      selected = checkbox.checked ? [...selected, sample.id] : selected.filter(id => id !== sample.id); renderSelection();
    });
    label.append(checkbox, element('span', '', sampleLabel(sample))); cell.append(label); row.append(cell);
    for (const text of [NOISES.find(noise => noise.id === sample.noise).label, sample.snr + ' dB', algorithmLabel(sample.algorithm)]) row.append(element('td', '', text));
    return row;
  }));
  $('#selected-queue').replaceChildren(...selected.map((id, index) => {
    const sample = SAMPLE_INDEX.get(id), item = element('li', '', sampleLabel(sample) + ' · ' + NOISES.find(noise => noise.id === sample.noise).label + ' · ' + sample.snr + ' dB · ' + algorithmLabel(sample.algorithm));
    const actions = element('span', 'queue-actions');
    for (const [direction, label] of [[-1, '↑'], [1, '↓']]) {
      const button = element('button', '', label); button.type = 'button'; button.disabled = index + direction < 0 || index + direction >= selected.length;
      button.setAttribute('aria-label', '음원 ' + (index + 1) + (direction < 0 ? ' 위로 이동' : ' 아래로 이동'));
      button.addEventListener('click', () => { [selected[index], selected[index + direction]] = [selected[index + direction], selected[index]]; $('#shuffle-order').checked = false; renderSelection(); });
      actions.append(button);
    }
    item.append(actions); return item;
  }));
}

function controlURL(sessionCode, token) {
  const url = new URL('survey-admin.html', location.href); url.search = '?session=' + sessionCode; url.hash = 'control=' + token; return url.href;
}

function renderControl(view) {
  active = view; $('#create-panel').hidden = true; $('#control-panel').hidden = false;
  $('#control-title').textContent = view.title; $('#session-phase').textContent = phases[view.phase];
  $('#current-trial').textContent = '음원 ' + (view.current_index + 1) + ' / ' + view.total;
  $('#participant-count').textContent = view.participants; $('#submitted-count').textContent = view.submitted;
  const player = $('#session-audio');
  if (audioId !== view.current_sample.id) {
    player.pause(); player.src = new URL('/' + view.current_sample.path + '?v=' + view.current_sample.sha256, location.origin).href;
    audioId = view.current_sample.id;
  }
  player.hidden = ['waiting', 'closed'].includes(view.phase);
  $('#current-source').textContent = view.current_sample.id;
  $('#start-session').hidden = view.phase !== 'waiting';
  $('#open-responses').hidden = view.phase !== 'listening';
  $('#next-trial').hidden = !['listening', 'answering'].includes(view.phase) || view.current_index + 1 >= view.total;
  $('#close-session').hidden = view.phase === 'closed';
  for (const button of document.querySelectorAll('#control-panel button')) button.disabled = busy;
  $('#control-help').textContent = {
    waiting: '참가자가 QR로 접속하면 평가를 시작하세요.',
    listening: '현재 음원을 재생한 뒤 응답 시작을 눌러 질문을 여세요.',
    answering: '제출 인원을 확인하고 다음 음원으로 이동하세요. 접수하지 않은 답변은 미응답으로 남습니다.',
    closed: '이 회차의 응답은 청음결과표와 지표청음 비교에 반영됩니다.',
  }[view.phase];
}

async function refreshControl() {
  if (!active || busy || document.hidden) return;
  try { renderControl(await api('/api/survey-sessions/' + active.code, { token: controlToken })); }
  catch (error) {
    if (error.status === 410) { active = null; $('#session-audio').pause(); $('#control-panel').hidden = true; await refreshSessions(); }
    showMessage(error.message, true);
  }
}

async function openControl(sessionCode, token) {
  const view = await api('/api/survey-sessions/' + sessionCode, { token });
  if (!view.samples) throw new Error('진행자 전용 링크를 확인하세요.');
  controlToken = token; storedValue('cnr-control-' + sessionCode, token);
  const participantURL = new URL('survey.html?session=' + sessionCode, location.href).href;
  const qr = qrcode(0, 'M'); qr.addData(participantURL); qr.make();
  qrSVG = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
  $('#session-qr').innerHTML = qrSVG;
  const graphic = $('#session-qr svg'); graphic.setAttribute('role', 'img'); graphic.setAttribute('aria-label', '이 회차의 참가자 접속 QR');
  $('#participant-link').href = participantURL; $('#participant-link').textContent = participantURL;
  const privateURL = controlURL(sessionCode, token);
  $('#control-link').href = privateURL; $('#control-link').textContent = privateURL;
  history.replaceState(null, '', privateURL);
  renderControl(view);
}

async function refreshSessions() {
  const result = await api('/api/survey-sessions');
  $('#session-list').replaceChildren(...result.sessions.map(session => {
    const row = element('a', '', session.title);
    const token = storedValue('cnr-control-' + session.code);
    row.href = token ? controlURL(session.code, token) : 'survey.html?session=' + session.code;
    row.append(element('small', '', phases[session.phase] + ' · ' + (token ? '진행 화면 열기' : '참가 화면 열기')));
    return row;
  }));
  if (!result.sessions.length) $('#session-list').append(element('p', 'survey-muted', '생성한 평가 회차가 없습니다.'));
}

for (const [selector, values] of [
  ['#select-algorithm', EVALUATION_METHODS.map(method => [method.id, method.label])],
  ['#select-noise', NOISES.map(noise => [noise.id, noise.label])],
  ['#select-snr', [...SNRS].sort((a, b) => a - b).map(snr => [String(snr), snr + ' dB'])],
]) for (const [value, label] of values) $(selector).add(new Option(label, value));
for (const selector of ['#select-algorithm', '#select-noise', '#select-snr']) $(selector).addEventListener('change', renderSelection);
$('#select-visible').addEventListener('click', () => { selected = [...new Set([...selected, ...visibleSamples().map(sample => sample.id)])]; renderSelection(); });
$('#clear-selection').addEventListener('click', () => { selected = []; renderSelection(); });

$('#create-session').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !selected.length) return;
  busy = true; renderSelection();
  try {
    const title = $('#session-title').value.trim();
    const signature = JSON.stringify({ title, selected, shuffle: $('#shuffle-order').checked });
    if (pendingCreation?.signature !== signature) {
      const ids = [...selected];
      if ($('#shuffle-order').checked) for (let index = ids.length - 1; index > 0; index--) {
        const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
        [ids[index], ids[random]] = [ids[random], ids[index]];
      }
      pendingCreation = { signature, body: { title, sample_ids: ids, creation_token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') } };
      storedValue('cnr-create-request', JSON.stringify(pendingCreation));
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('session:' + pendingCreation.body.creation_token));
    const predictedCode = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 12);
    storedValue('cnr-control-' + predictedCode, pendingCreation.body.creation_token);
    const result = await api('/api/survey-sessions', { method: 'POST', body: pendingCreation.body });
    storedValue('cnr-create-request', ''); pendingCreation = null;
    await openControl(result.code, result.control_token); await refreshSessions(); showMessage('회차를 만들었습니다. 참가자에게 QR을 보여 주세요.');
  } catch (error) { showMessage(error.message, true); }
  finally { busy = false; if (active) renderControl(active); else renderSelection(); }
});

for (const [selector, action] of [['#start-session', 'start'], ['#open-responses', 'open'], ['#next-trial', 'next'], ['#close-session', 'close']]) {
  $(selector).addEventListener('click', async () => {
    if (busy || !active) return;
    busy = true; $('#session-audio').pause(); renderControl(active);
    try {
      const view = await api('/api/survey-sessions/' + active.code + '/control', { method: 'POST', token: controlToken, body: { action, revision: active.revision } });
      renderControl(view); showMessage('');
    } catch (error) { showMessage(error.message, true); }
    finally { busy = false; await refreshControl(); }
  });
}
$('#session-audio').addEventListener('error', () => showMessage('음원을 재생하지 못했습니다. 파일 연결과 재생 장치를 확인하세요.', true));
$('#copy-control-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#control-link').href); showMessage('진행자 링크를 복사했습니다.'); }
  catch { showMessage('표시된 진행자 링크를 직접 복사해 주세요.'); }
});
$('#download-qr').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([qrSVG], { type: 'image/svg+xml' }));
  const link = element('a'); link.href = url; link.download = 'cnr-qr-' + active.code + '.svg'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function initialize() {
  if (code) {
    const token = new URLSearchParams(location.hash.slice(1)).get('control') || storedValue('cnr-control-' + code);
    if (!token) throw new Error('보관한 진행자 전용 링크로 접속하세요.');
    await openControl(code, token);
  } else {
    const [files, dataset, study] = await Promise.all([api('/api/files'), api('/dataset/manifest.json'), api('/api/study')]);
    const paths = { ...normalizeManifest(dataset), ...study.state.paths };
    candidates = EVALUATION_SAMPLES.filter(sample => files.files.includes(paths[sample.id])).sort(compareSelectionSamples);
    const saved = storedValue('cnr-create-request');
    if (saved) {
      try {
        pendingCreation = JSON.parse(saved);
        const previous = JSON.parse(pendingCreation.signature);
        if (!Array.isArray(previous.selected) || !Array.isArray(pendingCreation.body?.sample_ids) || !/^[a-f0-9]{64}$/.test(pendingCreation.body.creation_token)) throw new Error('Invalid saved creation');
        selected = previous.selected.filter(id => candidates.some(sample => sample.id === id));
        $('#session-title').value = previous.title; $('#shuffle-order').checked = previous.shuffle;
      } catch { pendingCreation = null; }
    }
    renderSelection();
  }
  await refreshSessions();
  setInterval(refreshControl, 2000);
}
initialize().catch(error => showMessage(error.message, true));
