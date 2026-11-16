import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendRequest } from '../../frontend/handler.ts';

test('화면 경로는 프론트엔드에서 처리하고 API·음원 경로는 넘긴다', async () => {
  const redirect = await frontendRequest(new Request('https://research.test/website?tab=results'));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), 'https://research.test/website/?tab=results');
  let fetched;
  const assets = { async fetch(request) {
    fetched = request;
    return new Response('<html lang="ko">report</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=3600' } });
  } };
  const page = await frontendRequest(new Request('https://research.test/website/'), assets);
  assert.equal(fetched.url, 'https://research.test/website/index.html');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('Content-Type'), 'text/html');
  assert.match(await page.text(), /report/);
  for (const route of ['/api/study', '/data/clean/test.wav', '/outputs/test.wav', '/website/survey.html']) {
    assert.equal(await frontendRequest(new Request('https://research.test' + route), assets), null);
  }
  assert.equal(await frontendRequest(new Request('https://research.test/website/')), null);
});
