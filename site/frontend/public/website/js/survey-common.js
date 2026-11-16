export const RATING_SCALES = [
  { name: 'noise', label: '소음 방해 정도', levels: ['음성을 거의 전부 가림', '말을 자주 가림', '집중해야 들림', '방해가 적음', '이해를 거의 방해하지 않음'] },
  { name: 'naturalness', label: '음성 자연스러움', levels: ['심한 왜곡·끊김', '왜곡이 이해를 방해', '기계음·떨림이 뚜렷함', '약간의 왜곡', '뚜렷한 왜곡·끊김 없음'] },
];
export const SCORE_VALUES = [0, 2.5, 5, 7.5, 10];
export const $ = selector => document.querySelector(selector);
export function element(tag, className = '', text = '') {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}
export function showMessage(message, error = false) {
  const target = $('#survey-message'); target.textContent = message; target.classList.toggle('error', error); target.hidden = !message;
}
export async function api(path, { token, body, method = 'GET' } = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, cache: 'no-store', signal: controller.signal,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '요청을 처리하지 못했습니다.'), { status: response.status });
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요.');
    throw error;
  } finally { clearTimeout(timeout); }
}

export function storedValue(key, value) {
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      if (value !== undefined) { storage().setItem(key, value); return value; }
      const saved = storage().getItem(key);
      if (saved) return saved;
    } catch { /* The next browser storage may still be available. */ }
  }
  if (value !== undefined) throw new Error('참가 정보를 저장할 수 없습니다. 브라우저의 사이트 저장 기능을 확인하세요.');
  return null;
}
