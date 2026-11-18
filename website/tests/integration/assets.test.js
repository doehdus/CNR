import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { researchRequest } from '../../backend/api/research.ts';

test('화면과 공용 모듈이 기존 URL에 연결되고 서버 소스는 정적 자산에서 제외된다', async () => {
  for (const [file, source] of [
    ['index.html', 'collection/index.html'], ['survey.html', 'listening-test/survey.html'],
    ['survey-admin.html', 'listening-test/survey-admin.html'], ['js/audio-comparison.js', 'comparison/audio-comparison.js'],
    ['js/files.js', 'collection/files.js'], ['css/style.css', 'collection/style.css'],
    ['js/clean-library.js', 'collection/clean-library.js'],
    ['js/noise-analysis.js', 'comparison/noise-analysis.js'],
  ]) {
    assert.equal(await readFile(new URL('../../.sites-runtime/public/website/' + file, import.meta.url), 'utf8'),
      await readFile(new URL('../../src/' + source, import.meta.url), 'utf8'));
  }
  for (const name of ['dataset', 'evaluation', 'metrics', 'correlation', 'report', 'study-tables', 'noise-analysis-data', 'collection-data']) {
    assert.equal(await readFile(new URL('../../.sites-runtime/public/website/js/' + name + '.js', import.meta.url), 'utf8'),
      await readFile(new URL('../../shared/research/' + name + '.js', import.meta.url), 'utf8'));
  }
  const source = await import('../../shared/research/dataset.js');
  const deployed = await import('../../.sites-runtime/public/website/js/dataset.js');
  assert.deepEqual(deployed.SAMPLES, source.SAMPLES);
  assert.equal(source.download, undefined);
  assert.equal(source.readServerJSON, undefined);
  await import('../../.sites-runtime/public/website/js/files.js');
  const { default: qrcode } = await import('../../.sites-runtime/public/website/vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData('https://research.test/website/survey.html?code=fixture');
  qr.make();
  assert.match(qr.createSvgTag({ scalable: true }), /<svg/);
  assert.equal(await researchRequest(new Request('https://research.test/website/'), {}), null);
  const files = await readdir(new URL('../../.sites-runtime/public/', import.meta.url), { recursive: true });
  assert.ok(!files.some(file => /\.(?:ts|tsx|mts|sql)$/.test(file)));
  assert.ok(!files.some(file => /(?:^|[\\/])(?:backend|migrations|surveys)(?:[\\/]|$)/.test(file)));
});
