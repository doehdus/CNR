import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNoiseAnalysis } from '../../.sites-runtime/public/website/js/noise-analysis.js';

const summary = JSON.parse(readLegacyFixture('dataset/mixture_summary/results.json'));
const comparison = JSON.parse(readLegacyFixture('dataset/mixture_summary/snr_comparison.json'));
const peakComparison = JSON.parse(readLegacyFixture('dataset/mixture_summary/peak_comparison.json'));
const analysis = JSON.parse(readLegacyFixture('dataset/peak_analysis/results.json'));
class Element {
  constructor(tag = 'div', text = '') { this.tagName = tag; this.textContent = text; this.children = []; this.dataset = {}; this.value = ''; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; if (this.tagName === 'select') this.value = items[0]?.value || ''; }
  add(item) { this.append(item); }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  setAttribute(key, value) { this.attributes[key] = value; } removeAttribute(key) { delete this.attributes[key]; }
  querySelectorAll() { return []; }
  dispatch(type, event = { target: this, currentTarget: this }) { for (const callback of this.listeners[type] || []) callback(event); }
}

test('상단 평균과 하단 개별 선택·재생 경로를 독립적으로 유지한다', async t => {
  const elements = new Map();
  const get = selector => { if (!elements.has(selector)) elements.set(selector, new Element(selector.includes('select') ? 'select' : 'div')); return elements.get(selector); };
  const buttons = ['welch', 'peaks', 'temporal'].map(view => { const button = new Element('button'); button.dataset.summaryView = view; return button; });
  const comparisonButtons = ['psd', 'peaks', 'tracking', 'clean'].map(view => { const button = new Element('button'); button.dataset.comparisonView = view; return button; });
  const comparisonPanels = ['psd', 'peaks', 'tracking', 'clean'].map(view => { const panel = new Element(); panel.dataset.comparisonPanel = view; return panel; });
  let summaryResponse = summary;
  let comparisonResponse = comparison;
  let peakResponse = peakComparison;
  t.mock.method(globalThis, 'fetch', async url => {
    const data = String(url).endsWith('/peak_comparison.json') ? peakResponse : String(url).endsWith('/snr_comparison.json') ? comparisonResponse : String(url).includes('/mixture_summary/') ? summaryResponse : analysis;
    return { ok: true, status: data === null ? 404 : 200, json: async () => structuredClone(data) };
  });
  for (const [key, value] of Object.entries({
    document: { querySelector: get, querySelectorAll: selector => selector === '[data-summary-view]' ? buttons : selector === '[data-comparison-view]' ? comparisonButtons : selector === '[data-comparison-panel]' ? comparisonPanels : [], createElement: tag => new Element(tag) },
    window: new Element(), location: { href: 'https://research.test/website/#mixture-analysis' },
    Option: class extends Element { constructor(label, value) { super('option', label); this.value = value; } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const app = createNoiseAnalysis({ fingerprints: () => Object.fromEntries(analysis.files.map(file => [file.path, file.sha256])), stopAudio() {} });
  app.initialize(); await app.load(); app.navigate('mixture-analysis', 'welch'); app.render();
  assert.equal(get('#mixture-summary-results').hidden, false);
  assert.equal(get('#mixture-snr-comparison-results').hidden, false);
  const plotURLs = ['single', 'complex', 'changing'].map(noise => get('#mixture-snr-comparison-' + noise).children[0].children[0].href);
  for (const [i, noise] of ['single', 'complex', 'changing'].entries()) assert.equal(new URL(plotURLs[i]).pathname, '/dataset/mixture_summary/' + comparison.graphs[noise]);
  assert.match(get('#mixture-snr-comparison-note').textContent, /-80.*-20/);
  for (const [index, kind] of ['peaks', 'tracking', 'clean'].entries()) {
    comparisonButtons[index + 1].dispatch('click');
    assert.equal(comparisonPanels[index + 1].hidden, false);
    assert.equal(get('#mixture-peak-comparison-' + kind).hidden, false);
    for (const noise of ['single', 'complex', 'changing']) {
      const url = get('#mixture-peak-comparison-' + kind + '-' + noise).children[0].children[0].href;
      assert.equal(new URL(url).pathname, '/dataset/mixture_summary/' + peakComparison.graphs[noise + '/' + kind]);
    }
  }
  assert.equal(get('#mixture-peak-comparison-counts').children[0].children[1].children.length, 160);
  get('#mixture-summary-noise').value = 'changing'; get('#mixture-summary-noise').dispatch('change');
  get('#mixture-summary-snr').value = '0'; get('#mixture-summary-snr').dispatch('change');
  buttons[1].dispatch('click');
  assert.match(get('#mixture-summary-caption').textContent, /변화 소음.*0dB/);
  assert.match(get('#mixture-c-caption').textContent, /단일 소음.*20dB/);
  assert.equal(get('#mixture-summary-change-section').hidden, false);
  get('#mixture-analysis-snr').value = '5'; get('#mixture-analysis-snr').dispatch('change');
  get('#mixture-c-matrix').dispatch('click', { target: { closest: () => ({ dataset: { matrixAction: 'select', noise: 'complex', statement: 'warning04' } }) } });
  assert.match(get('#mixture-c-caption').textContent, /복합 소음.*warning04.*5dB/);
  assert.match(get('#mixture-summary-caption').textContent, /변화 소음.*0dB/);
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  assert.deepEqual(['single', 'complex', 'changing'].map(noise => get('#mixture-snr-comparison-' + noise).children[0].children[0].href), plotURLs);
  const audio = get('#mixture-c-players').children[1].children.find(child => child.tagName === 'audio');
  assert.match(audio.src, /data\/mixed\/complex\/snr05\/warning04.wav$/);
  const original = get('#mixture-c-caption').textContent;
  summaryResponse = null; await app.load(); app.render();
  assert.equal(get('#mixture-summary-results').hidden, true);
  assert.equal(get('#mixture-c-caption').textContent, original);
  summaryResponse = summary; comparisonResponse = comparison; peakResponse = structuredClone(peakComparison); peakResponse.method.appearance_missing = 'exclude';
  await app.load(); app.render();
  assert.equal(get('#mixture-peak-comparison-tracking').hidden, true);
  assert.equal(get('#mixture-snr-comparison-results').hidden, false);
  assert.equal(get('#mixture-c-caption').textContent, original);
  summaryResponse = summary; comparisonResponse = structuredClone(comparison); comparisonResponse.source_summary_sha256 = '0'.repeat(64);
  await app.load(); app.render();
  assert.equal(get('#mixture-snr-comparison-results').hidden, true);
  assert.equal(get('#mixture-summary-results').hidden, false);
  assert.equal(get('#mixture-c-caption').textContent, original);
  summaryResponse = structuredClone(summary); summaryResponse.groups[0].members[0].clean_rms = 0;
  await app.load(); app.render();
  assert.equal(get('#mixture-summary-results').hidden, true);
  assert.match(get('#mixture-summary-status').textContent, /정규화/);
  assert.equal(get('#mixture-c-caption').textContent, original);
});
