import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBpfPrefilter } from '../../.sites-runtime/public/website/js/butterworth-prefilter.js';
const data = JSON.parse(readLegacyFixture('dataset/prefilter_bpf/results.json'));
const walk = e => [e, ...e.children.flatMap(walk)];
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.paused = true; this.classes = new Set(); this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) }; }
  append(...v) { this.children.push(...v); }
  replaceChildren(...v) { this.children = v; }
  add(v) { this.append(v); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(n, f) { (this.listeners[n] ??= []).push(f); }
  dispatch(n) { for (const f of this.listeners[n] || []) f({ target: this }); }
  play() { this.paused = false; this.dispatch('play'); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatch('pause'); } }
}
async function setup(t) {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let hashes = Object.fromEntries(data.conditions.flatMap(r => [[r.input_path, r.input_sha256], [r.output_path, r.output_sha256]]));
  for (const [key, value] of Object.entries({ document: { querySelector: get, createElement: tag => new Element(tag) },
    location: { href: 'https://research.test/website/#prefilter' }, Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } } })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => before ? Object.defineProperty(globalThis, key, before) : delete globalThis[key]);
  }
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, ok: true, json: async () => structuredClone(data) }));
  const app = createBpfPrefilter({ fingerprints: () => hashes, stopAudio(except) { for (const e of [...elements.values()].flatMap(walk)) if (e.tagName === 'audio' && e !== except) e.pause(); } });
  app.initialize(); await app.load(); app.render();
  return { app, get, setHashes: value => { hashes = value; }, kind: value => get('#prefilter-kind-options').children.find(e => e.dataset.prefilterKind === value),
    snr: value => get('#prefilter-snr-options').children.find(e => e.dataset.snr === String(value)),
    buttons: () => walk(get('#prefilter-matrix')).filter(e => e.tagName === 'button'), audios: () => walk(get('#prefilter-matrix')).filter(e => e.tagName === 'audio') };
}
test('한 표의 세로 12음원·가로 3소음이 음원 종류와 SNR의 전체 288개 재생 경로에 대응한다', async t => {
  const f = await setup(t);
  for (const kind of ['original', 'filtered']) {
    f.kind(kind).dispatch('click');
    assert.equal(f.kind(kind).attributes['aria-pressed'], 'true');
    for (const snr of [20, 10, 5, 0]) {
      f.snr(snr).dispatch('click'); assert.equal(f.snr(snr).attributes['aria-pressed'], 'true');
      const table = f.get('#prefilter-matrix').children[0], head = table.children.find(e => e.tagName === 'thead'), body = table.children.find(e => e.tagName === 'tbody');
      const columns = table.children.find(e => e.tagName === 'colgroup');
      assert.equal(columns.children.length, 4);
      assert(columns.children.slice(1).every(c => c.className === 'prefilter-noise-column'));
      assert.deepEqual(head.children[0].children.map(e => e.textContent), ['음원', '단일 소음', '복합 소음', '변화 소음']);
      assert.equal(body.children.length, 12);
      assert(body.children.every(row => row.children.length === 4));
      const buttons = f.buttons(), audios = f.audios(); assert.equal(buttons.length, 36); assert.equal(audios.length, 36);
      assert(audios.every(a => a.paused));
      for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i], audio = audios[i];
        const row = data.conditions.find(r => r.noise === button.dataset.noise && r.statement === button.dataset.statement && r.snr === snr);
        const expected = kind === 'filtered' ? row.output_path : row.input_path;
        assert.equal(button.dataset.audioPath, expected); assert.equal(new URL(audio.src).pathname, '/dataset/audio/' + expected);
        assert.equal(audio.preload, 'none'); assert.equal(audio.hidden, true);
        button.dispatch('click'); assert.equal(audio.paused, false); assert.equal(button.textContent, '일시정지');
        assert.equal(audios.filter(a => !a.paused).length, 1);
      }
    }
  }
});
test('같은 칸으로 일시정지하고 종류·SNR 변경 시 정지하며 지문 불일치는 재생을 막는다', async t => {
  const f = await setup(t);
  const first = f.buttons()[0], audio = f.audios()[0];
  first.dispatch('click'); first.dispatch('click'); assert.equal(audio.paused, true); assert.equal(first.textContent, '재생');
  first.dispatch('click'); f.kind('filtered').dispatch('click'); assert.equal(audio.paused, true); assert(f.audios().every(a => a.paused));
  const next = f.audios()[0]; f.buttons()[0].dispatch('click');
  f.snr(5).dispatch('click'); assert.equal(next.paused, true);
  assert(f.audios().every(a => a.paused)); assert.equal(f.snr(5).attributes['aria-pressed'], 'true'); assert.equal(f.kind('filtered').attributes['aria-pressed'], 'true');
  f.setHashes({}); f.app.render(); assert(f.buttons().every(b => b.disabled)); assert.equal(f.audios().length, 0);
  assert.match(f.get('#prefilter-status').textContent, /재생을 보류/);
});
