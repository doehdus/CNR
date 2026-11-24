import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNoiseAnalysis } from '../../.sites-runtime/public/website/js/noise-analysis.js';

// Exercise the controller with the same completed snapshot used by the build.
const measured = JSON.parse(readLegacyFixture('dataset/peak_analysis/results.json'));
class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag; this.textContent = text; this.children = []; this.dataset = {};
    this.listeners = {}; this.value = ''; this.classList = { toggle() {} };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; if (this.tagName === 'select') this.value = items[0]?.value || ''; }
  add(item) { this.append(item); }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  setAttribute() {} removeAttribute() {}
  querySelectorAll() { return []; }
  dispatch(type) { for (const callback of this.listeners[type] || []) callback({ target: this, currentTarget: this }); }
}

test('Noise 선택 입력·확정·화면 복귀에 그래프와 표를 함께 갱신한다', async t => {
  const elements = new Map(), page = new Element();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element(selector.includes('select') ? 'select' : 'div'));
    return elements.get(selector);
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => structuredClone(measured) }));
  for (const [key, value] of Object.entries({
    document: { querySelector: get, querySelectorAll: () => [], createElement: tag => new Element(tag) },
    window: page, location: { href: 'https://research.test/website/#noise-analysis/peaks' },
    Option: class extends Element { constructor(label, value) { super('option', label); this.value = value; } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  let fingerprints = Object.fromEntries(measured.files.map(file => [file.path, file.sha256]));
  const app = createNoiseAnalysis({ fingerprints: () => fingerprints, stopAudio() {} });
  get('#noise-analysis-source').value = 'single';
  app.initialize(); await app.load(); app.navigate('noise-analysis', 'peaks'); app.render();
  function check(noise) {
    const source = measured.sources.find(row => row.noise === noise);
    for (const kind of ['welch', 'peaks', 'temporal']) {
      const link = get('#noise-c-' + kind).children[0].children[0];
      assert.equal(new URL(link.href).pathname, '/dataset/peak_analysis/' + source.graphs[kind]);
    }
    const table = get('#noise-c-peak-table').children[0];
    const rows = table.children[1].children;
    assert.deepEqual(rows.map(row => row.children[1].textContent), source.peaks.map(peak => peak.frequency_hz.toLocaleString('ko-KR', { maximumFractionDigits: 2 })));
    const format = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
    if (noise === 'changing') {
      assert.match(table.children[0].children[0].children[2].textContent, /2.5초 이전/);
      for (const [index, peak] of source.peaks.entries()) {
        const bin = measured.frequency_hz.indexOf(peak.frequency_hz);
        assert.deepEqual(rows[index].children.slice(2).map(cell => cell.textContent),
          [source.before_psd_db[bin], source.after_psd_db[bin], peak.time_change_db].map(format));
      }
      const average = get('#noise-c-peak-table').children.find(child => child.tagName === 'details');
      assert(average, 'Keep the original whole-record peak table available.');
      const originalRows = average.children[1].children[0].children[1].children;
      assert.equal(originalRows[0].children[2].textContent, format(source.peaks[0].bandwidth_hz));
    } else {
      assert.equal(rows[0].children[2].textContent, format(source.peaks[0].bandwidth_hz));
      assert.equal(rows[0].children[3].textContent, format(source.peaks[0].magnitude_db));
    }
    assert.match(get('#noise-analysis-status').textContent, new RegExp({ single: '단일', complex: '복합', changing: '변화' }[noise]));
  }
  check('single');
  for (const [noise, event] of [['complex', 'input'], ['changing', 'change'], ['single', 'input']]) {
    get('#noise-analysis-source').value = noise;
    get('#noise-analysis-source').dispatch(event);
    check(noise);
  }
  // Back/forward restoration may change the select without any input event.
  get('#noise-analysis-source').value = 'changing'; page.dispatch('pageshow'); check('changing');
  get('#noise-analysis-source').value = 'complex'; app.navigate('noise-analysis', 'welch'); check('complex');
  // Selecting a new source must also refresh the stale-data status.
  fingerprints = {};
  get('#noise-analysis-source').value = 'single'; get('#noise-analysis-source').dispatch('input');
  assert.match(get('#noise-analysis-status').textContent, /표시를 보류/);
});
