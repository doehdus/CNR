import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixedPrefilter } from '../../.sites-runtime/public/website/js/prefilter.js';
const measured = JSON.parse(readLegacyFixture('dataset/prefilter/results.json'));
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  add(item) { this.append(item); }
  setAttribute() {}
  addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
  querySelector(tag) { return this.children.find(child => child.tagName === tag) || null; }
  remove() {}
  dispatch(name) { for (const callback of this.listeners[name] || []) callback({ target: this }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
test('두 표의 36개 재생 경로가 모든 SNR에서 정확히 대응하고 지문 변경 시 재생을 보류한다', async t => {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let fingerprints = Object.fromEntries(measured.conditions.flatMap(row => [[row.input_path, row.input_sha256], [row.output_path, row.output_sha256]]));
  let stopped = 0;
  const globals = { document: { querySelector: get, createElement: tag => new Element(tag) },
    location: { href: 'https://research.test/website/#prefilter' },
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } } };
  for (const [name, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => structuredClone(measured) }));
  const app = createFixedPrefilter({ fingerprints: () => fingerprints, stopAudio() { stopped++; } });
  app.initialize(); await app.load(); app.render();
  for (const snr of [20, 10, 5, 0]) {
    get('#prefilter-snr').value = String(snr); get('#prefilter-snr').dispatch('change');
    const input = descendants(get('#prefilter-original-matrix')).filter(node => node.tagName === 'audio');
    const output = descendants(get('#prefilter-filtered-matrix')).filter(node => node.tagName === 'audio');
    assert.equal(input.length, 36); assert.equal(output.length, 36);
    const expected = ['single', 'complex', 'changing'].flatMap(noise => measured.recordings.map(r => measured.conditions.find(c => c.noise === noise && c.snr === snr && c.statement === r.id)));
    for (let index = 0; index < 36; index++) {
      assert.equal(new URL(input[index].src).pathname, '/dataset/audio/' + expected[index].input_path);
      assert.equal(new URL(output[index].src).pathname, '/dataset/audio/' + expected[index].output_path);
      assert.equal(output[index].preload, 'none');
    }
    output[0].dispatch('play');
  }
  assert(stopped > 4);
  assert.match(get('#prefilter-status').textContent, /144.*144/);
  fingerprints = {}; app.render();
  assert.equal(descendants(get('#prefilter-filtered-matrix')).filter(node => node.tagName === 'audio').length, 0);
  assert.match(get('#prefilter-status').textContent, /재생을 보류/);
});
test('설명 섹션을 제거하고 음원 종류·SNR 선택 다음에 하나의 재생표를 둔다', async () => {
  const html = await readFile(new URL('../../src/collection/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="prefilter-preparation"|href="#prefilter-preparation"/);
  const page = html.slice(html.indexOf('<section id="prefilter"'), html.indexOf('<section id="demo"'));
  assert.doesNotMatch(page, /고정 Butterworth BPF|설계에서 예상한 변화|같은 조건으로 들어보기|prefilter-fixed-settings|prefilter-original-matrix|prefilter-filtered-matrix/);
  assert(page.indexOf('id="prefilter-kind-options"') < page.indexOf('id="prefilter-matrix"'));
  assert(page.indexOf('id="prefilter-snr-options"') < page.indexOf('id="prefilter-matrix"'));
  assert.equal((page.match(/id="prefilter-matrix"/g) || []).length, 1);
  assert.match(html, /id="mixture-c-comparison"/);
});
