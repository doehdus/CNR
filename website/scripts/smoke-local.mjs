import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { initializeLocalDatabase, localSiteRoot } from './init-local-db.mjs';
import { configureToolEnvironment } from './tool-environment.mjs';

configureToolEnvironment(localSiteRoot);
const collection = JSON.parse(await readFile(path.join(localSiteRoot, 'public/dataset/collection.json'), 'utf8'));
const catalog = JSON.parse(await readFile(path.join(localSiteRoot, 'public/dataset/audio/catalog.json'), 'utf8'));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const state = await mkdtemp(path.join(localSiteRoot, '.wrangler/smoke-'));
let child, output = '';
try {
  await initializeLocalDatabase({ stateDirectory: state });
  child = spawn(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'dev',
    '--config', 'dist/server/wrangler.json', '--local', '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], {
    cwd: localSiteRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', WRANGLER_SEND_METRICS: 'false' },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-6000); });
  const origin = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(origin + '/website/', { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(ready, 'Local server did not start.\n' + output);
  const html = await (await fetch(origin + '/website/')).text();
  assert.ok(html.includes('instruction-library') && html.includes('warning-library'));
  assert.equal((await fetch(origin + '/website/js/clean-library.js')).status, 200);
  assert.equal((await (await fetch(origin + '/dataset/collection.json')).json()).recordings.length, 12);
  const files = await (await fetch(origin + '/api/files')).json();
  assert.equal(catalog.files.length, 15);
  for (const file of catalog.files) {
    assert.ok(files.files.includes(file.path));
    assert.equal(files.fingerprints[file.path], file.sha256);
    const response = await fetch(origin + '/' + file.path, { headers: { Range: 'bytes=0-43' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 44);
  }
  assert.equal(collection.recordings.length, 12);
  const study = await (await fetch(origin + '/api/study')).json();
  const stateBefore = structuredClone(study.state);
  const edited = { ...stateBefore, noise_paths: { ...stateBefore.noise_paths, noise_single: 'data/noise/single.wav' } };
  const saved = await fetch(origin + '/api/study', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ revision: study.revision, state: edited }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const updated = await saved.json();
  assert.equal((await (await fetch(origin + '/api/study')).json()).state.noise_paths.noise_single, 'data/noise/single.wav');
  assert.equal((await fetch(origin + '/api/study', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ revision: updated.revision, state: stateBefore }) })).status, 200);
  console.log('Local smoke check passed: 15 WAVs, 12 recordings, local R2 listing, local D1 read/write, no deployment credentials.');
} finally {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (path.dirname(state) === path.join(localSiteRoot, '.wrangler') && path.basename(state).startsWith('smoke-')) await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
