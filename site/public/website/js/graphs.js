import { algorithmLabel } from './dataset.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function svgElement(tag, attributes, text) {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderMetricTrend(target, points, key, algorithm, minimum = 0) {
  if (!points.some(point => point.count)) {
    const empty = document.createElement('p');
    empty.className = 'graph-empty';
    empty.textContent = '같은 조건의 무처리·처리 지표를 계산하면 SNR별 변화가 표시됩니다.';
    target.replaceChildren(empty);
    return;
  }

  const svg = svgElement('svg', {
    viewBox: '0 0 560 320', role: 'img',
    'aria-label': key.toUpperCase() + ' SNR별 무처리와 ' + algorithmLabel(algorithm) + ' 평균 비교',
  });
  const left = 54, right = 530, top = 26, bottom = 255;
  const x = snr => left + snr / 20 * (right - left);
  const y = value => bottom - (value - minimum) / (1 - minimum) * (bottom - top);

  for (let index = 0; index <= 4; index++) {
    const value = minimum + (1 - minimum) * index / 4;
    svg.append(
      svgElement('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'graph-gridline' }),
      svgElement('text', { x: left - 12, y: y(value) + 4, 'text-anchor': 'end' }, value.toFixed(2)),
    );
  }
  for (const point of points) {
    svg.append(
      svgElement('text', { x: x(point.snr), y: bottom + 22, 'text-anchor': 'middle' }, point.snr),
      svgElement('text', { x: x(point.snr), y: bottom + 41, 'text-anchor': 'middle', class: 'graph-count' }, 'n=' + point.count),
    );
  }
  svg.append(
    svgElement('text', { x: left, y: 14 }, key.toUpperCase()),
    svgElement('text', { x: right, y: 315, 'text-anchor': 'end' }, '입력 SNR (dB)'),
  );

  for (const series of [
    { field: 'baseline', label: '무처리', color: '#bd7736', dash: '6 5' },
    { field: 'processed', label: algorithmLabel(algorithm), color: '#174e47', dash: '' },
  ]) {
    // Start a new segment after a missing SNR so absent values remain visible.
    let previous = null;
    for (const point of points) {
      if (!Number.isFinite(point[series.field])) {
        previous = null;
        continue;
      }
      if (previous) svg.append(svgElement('line', {
        x1: x(previous.snr), y1: y(previous[series.field]),
        x2: x(point.snr), y2: y(point[series.field]),
        stroke: series.color, 'stroke-width': 2.5, 'stroke-dasharray': series.dash,
      }));
      const label = series.label + ', SNR ' + point.snr + ' dB, ' + key.toUpperCase() + ' ' + point[series.field].toFixed(3) + ', 대응 음원 ' + point.count + '개';
      const circle = svgElement('circle', {
        cx: x(point.snr), cy: y(point[series.field]), r: 5,
        fill: series.color, stroke: '#fff', 'stroke-width': 1.5,
        tabindex: 0, 'aria-label': label,
      });
      circle.append(svgElement('title', {}, label));
      svg.append(circle);
      previous = point;
    }
  }
  target.replaceChildren(svg);
}
