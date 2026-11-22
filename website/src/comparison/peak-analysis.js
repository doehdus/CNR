// Display helpers for completed C analysis. No waveform or DSP calculations run here.
export const element = (tag, className = '', text = '') => {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
};
export const number = value => Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
export const assetURL = path => new URL('../dataset/peak_analysis/' + path, location.href);

export function analysisTable(host, headings, rows, message = '현재 기준에서 검출된 결과가 없습니다.') {
  const table = element('table'), head = element('thead'), line = element('tr'), body = element('tbody');
  headings.forEach(label => { const cell = element('th', '', label); cell.scope = 'col'; line.append(cell); });
  head.append(line);
  for (const values of rows) {
    const row = element('tr'); values.forEach((value, index) => {
      const cell = element('td', '', String(value)); cell.dataset.label = headings[index]; row.append(cell);
    }); body.append(row);
  }
  if (!rows.length) { const row = element('tr'), cell = element('td', 'empty-cell', message); cell.colSpan = headings.length; row.append(cell); body.append(row); }
  table.append(head, body); host.replaceChildren(table);
}

export function analysisFigure(host, path, hashes, title, base = 'peak_analysis') {
  if (!path || !hashes[path]) { host.replaceChildren(element('p', 'artifact-empty', '완료된 그래프 등록 대기')); return; }
  const figure = element('figure', 'noise-figure'), image = element('img'), link = element('a', 'button secondary small', 'PNG 저장');
  const url = new URL('../dataset/' + base + '/' + path, location.href); url.searchParams.set('v', hashes[path]);
  image.src = url.href; image.alt = title; image.loading = 'lazy';
  image.addEventListener('error', () => { host.replaceChildren(element('p', 'artifact-empty', '그래프를 읽지 못했습니다. 새로고침 후 다시 확인해 주세요.')); });
  link.href = url.href; link.download = path.split('/').at(-1);
  const original = element('a'); original.href = url.href; original.target = '_blank'; original.rel = 'noopener';
  original.setAttribute('aria-label', title + ' 원본 크기로 열기'); original.append(image);
  figure.append(original, element('figcaption', '', title + ' · 그래프를 누르면 원본 크기로 열립니다.'), link); host.replaceChildren(figure);
}

export function analysisPlayer(path, title, stopAudio) {
  const card = element('article', 'audio-card');
  card.append(element('h3', '', title));
  const audio = element('audio'); audio.controls = true; audio.preload = 'none';
  audio.src = new URL('../dataset/audio/' + path, location.href).href;
  audio.setAttribute('aria-label', title);
  audio.addEventListener('play', () => stopAudio(audio));
  const error = element('p', 'audio-error', '음원을 재생하지 못했습니다.'); error.hidden = true;
  audio.addEventListener('error', () => { error.hidden = false; });
  card.append(audio, error); return card;
}

export function peakRows(peaks) {
  return peaks.map(peak => [peak.id, number(peak.frequency_hz), number(peak.bandwidth_hz), number(peak.magnitude_db), number(peak.prominence_db)]);
}

export function renderNoisePeaks(host, source, frequency) {
  const headings = ['피크', '중심 주파수 (Hz)', '측정 폭 (Hz)', 'PSD (dBFS/Hz)', '돌출도 (dB)'];
  if (source.noise !== 'changing') {
    analysisTable(host, headings, peakRows(source.peaks));
    host.append(element('p', 'analysis-help', '전체 구간 평균 PSD의 피크입니다. 피크 번호는 각 소음 안의 PSD 크기순이며, 같은 번호가 같은 장비나 성분을 뜻하지 않습니다.'));
    return;
  }
  // Read completed C measurements at the same bin and measured band on both sides.
  // No spectrum, peak detection, or band-power calculation runs in the browser.
  analysisTable(host, ['전체 평균 피크', '중심 주파수 (Hz)', '2.5초 이전 PSD (dBFS/Hz)', '2.5초 이후 PSD (dBFS/Hz)', '측정 대역 전력 증감 (dB)'],
    source.peaks.map(peak => {
      const index = frequency.indexOf(peak.frequency_hz);
      return [peak.id, number(peak.frequency_hz), number(source.before_psd_db?.[index]), number(source.after_psd_db?.[index]), number(peak.time_change_db)];
    }));
  host.append(element('p', 'analysis-help', '2.5초부터 드릴이 추가되는 소음입니다. 전체 평균에서 찾은 같은 피크 중심과 측정 대역을 전후에 비교합니다. PSD 열은 중심 주파수의 밀도이고, 증감은 측정 폭 안의 대역 전력 차이(이후−이전)입니다. 양수는 증가입니다. 전후 구간에서 피크를 별도로 검출한 표는 아니며, 평균에서 검출되지 않은 변화는 포함하지 않습니다.'));
  const average = element('details', 'acoustic-method'), table = element('div', 'table-scroll noise-result-table');
  average.append(element('summary', '', '전체 구간 평균 피크 · 측정 폭·PSD·돌출도'));
  analysisTable(table, headings, peakRows(source.peaks));
  average.append(table); host.append(average);
}

export function renderTracking(host, signal) {
  const tracks = [...signal.tracking.tracks].sort((a, b) => b.count - a.count || a.id - b.id);
  const peakSummary = element('div', 'table-scroll noise-result-table');
  analysisTable(peakSummary, ['평균 PSD 피크', '중심 / 폭 (Hz)', '대표 궤적', '궤적 평균 (Hz)', '표준편차 (Hz)', '출현율 (%)'],
    signal.peaks.map((peak, index) => {
      const id = signal.tracking.peak_track_ids[index], track = tracks.find(value => value.id === id);
      const stats = track;
      return [peak.id, number(peak.frequency_hz) + ' / ' + number(peak.bandwidth_hz), track ? 'T' + id : '대응 없음',
        number(stats?.mean_hz), number(stats?.std_hz), number(stats?.appearance_percent)];
    }));
  const guide = element('p', 'analysis-help', '각 평균 PSD 피크 주변에서 가장 오래 연결된 궤적의 C 계산값입니다. 끊긴 궤적을 합산하지 않으며, 전체 궤적은 아래에서 확인할 수 있습니다.');
  const intro = element('p', 'analysis-help', `전체 ${signal.frame_count}프레임 기준 · 독립 궤적 ${tracks.length}개. 연결이 끊기면 새 궤적이며, 출현율은 해당 궤적이 검출된 프레임의 비율입니다.`);
  const table = element('div', 'table-scroll noise-result-table'), more = element('button', 'button secondary small', '전체 궤적 표시');
  const show = all => {
    analysisTable(table, ['궤적', '평균 주파수 (Hz)', '표준편차 (Hz)', '평균 폭 (Hz)', '출현율 (%)', '검출 프레임', '전체 궤적 구간 (초)'],
      (all ? tracks : tracks.slice(0, 20)).map(track => {
        const stats = track;
        return ['T' + track.id, number(stats.mean_hz), number(stats.std_hz), number(stats.mean_width_hz), number(stats.appearance_percent),
          stats.count, number(track.start_sec) + '–' + number(track.end_sec)];
      }));
    more.hidden = all || tracks.length <= 20;
  };
  more.type = 'button'; more.addEventListener('click', () => show(true));
  const all = element('details', 'acoustic-method');
  all.append(element('summary', '', '전체 궤적 목록 · ' + tracks.length + '개'), intro, table, more);
  host.replaceChildren(element('h3', '', '주요 피크 주변 궤적의 안정성'), guide, peakSummary, all); show(false);
}
