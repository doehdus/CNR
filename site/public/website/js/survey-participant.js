import { $, element, api, storedValue, showMessage, RATING_SCALES, SCORE_VALUES } from './survey-common.js';

const code = new URLSearchParams(location.search).get('session');
let token = null, joined = false, busy = false, latest = null;
const storageKey = 'cnr-participant-' + code;
const endpoint = '/api/survey-sessions/' + code;

function waiting(title, description = '') {
  $('#waiting-title').textContent = title; $('#waiting-description').textContent = description;
  $('#waiting-panel').hidden = false; $('#response-panel').hidden = true;
}

function choiceGroup(name, prompt, options) {
  const fieldset = element('fieldset', 'survey-question');
  fieldset.append(element('legend', '', prompt));
  const choices = element('div', 'survey-options');
  for (const option of options) {
    const label = element('label', 'survey-option'), radio = document.createElement('input');
    radio.type = 'radio'; radio.name = name; radio.value = String(option.id); radio.required = true;
    const text = element('span', '', option.label);
    if (option.description) text.append(element('small', '', option.description));
    label.append(radio, text); choices.append(label);
  }
  fieldset.append(choices); return fieldset;
}

function render(view) {
  latest = view; $('#survey-title').textContent = view.title;
  $('#participant-label').textContent = view.participant_label || '';
  $('#join-panel').hidden = joined || view.phase === 'closed';
  if (!joined && view.phase !== 'closed') { $('#waiting-panel').hidden = true; return; }
  const progress = '음원 ' + (view.current_index + 1) + ' / ' + view.total;
  if (view.phase === 'closed') { waiting('평가가 종료되었습니다.', '참여해 주셔서 감사합니다. 접수된 응답은 저장되었습니다.'); return; }
  if (view.phase === 'waiting') { waiting('평가 시작을 기다리고 있습니다.', '진행자가 시작하면 화면이 자동으로 바뀝니다.'); return; }
  if (view.phase === 'listening') { waiting(progress, '진행자가 재생하는 음원을 들어 주세요. 응답 시간이 되면 질문이 열립니다.'); return; }
  if (view.submitted_current) { waiting('응답이 저장되었습니다.', progress + ' · 다음 음원을 기다려 주세요.'); return; }
  if (!view.questions) { waiting('질문지를 불러오고 있습니다.'); return; }
  const form = $('#response-form');
  if (form.dataset.trialIndex !== String(view.current_index)) {
    if (form.dataset.trialIndex !== undefined && !$('#response-panel').hidden) showMessage('진행자가 다음 음원으로 이동했습니다. 현재 음원 번호를 확인하세요.');
    form.reset(); form.dataset.trialIndex = String(view.current_index);
    $('#key-questions').replaceChildren(...view.questions.map(question => choiceGroup('answer.' + question.id, question.prompt, question.options)));
    $('#rating-questions').replaceChildren(...RATING_SCALES.map(scale => choiceGroup(scale.name, scale.label, SCORE_VALUES.map((score, index) => ({ id: score, label: scale.levels[index], description: String(score) + '점' })))));
  }
  $('#trial-progress').textContent = progress;
  $('#waiting-panel').hidden = true; $('#response-panel').hidden = false;
}

async function refresh() {
  if (busy || document.hidden) return;
  try {
    const view = await api(endpoint, { token: joined ? token : null });
    render(view); $('#retry-survey').hidden = true;
  } catch (error) { if (!deletedQR(error)) { showMessage(error.message, true); $('#retry-survey').hidden = false; } }
}
function deletedQR(error) {
  if (error.status !== 410) return false;
  latest = null;
  waiting('삭제된 QR입니다.', '진행자에게 새 QR을 요청하세요.');
  $('#join-panel').hidden = true; $('#retry-survey').hidden = true; showMessage('');
  return true;
}

async function join() {
  if (busy) return;
  busy = true; $('#join-survey').disabled = true;
  try {
    if (!token) {
      token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    }
    storedValue(storageKey, token);
    await api(endpoint + '/join', { method: 'POST', body: { token } });
    joined = true; showMessage('');
    render(await api(endpoint, { token }));
  } catch (error) { if (!deletedQR(error)) { showMessage(error.message, true); $('#retry-survey').hidden = false; } }
  finally { busy = false; $('#join-survey').disabled = false; }
}

$('#join-survey').addEventListener('click', join);
$('#retry-survey').addEventListener('click', () => joined ? refresh() : token ? join() : refresh());
$('#response-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !latest?.questions) return;
  const fields = new FormData(event.currentTarget), trialIndex = Number(event.currentTarget.dataset.trialIndex);
  const answers = Object.fromEntries(latest.questions.map(question => [question.id, fields.get('answer.' + question.id)]));
  const scores = Object.fromEntries(RATING_SCALES.map(scale => [scale.name, fields.get(scale.name)]));
  busy = true; $('#submit-response').disabled = true;
  try {
    await api(endpoint + '/responses', { token, method: 'POST', body: { trial_index: trialIndex, answers, ...scores } });
    showMessage(''); waiting('응답이 저장되었습니다.', '다음 음원을 기다려 주세요.');
  } catch (error) { showMessage(error.message, true); $('#retry-survey').hidden = false; }
  finally { busy = false; $('#submit-response').disabled = false; await refresh(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

async function initialize() {
  if (!/^[a-f0-9]{12}$/.test(code || '')) { waiting('회차 주소를 확인하세요.', '진행자가 제공한 QR을 다시 스캔해 주세요.'); return; }
  token = storedValue(storageKey);
  if (token) await join(); else await refresh();
  setInterval(refresh, 2000);
}
initialize().catch(error => showMessage(error.message, true));
