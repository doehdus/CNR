import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function catalogFiles(projectRoot) {
  const root = await realpath(projectRoot), files = [];
  const inside = target => { const relative = path.relative(root, target); return !relative.startsWith('..') && !path.isAbsolute(relative); };
  async function walk(directory) {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.wav$/i.test(entry.name)) {
        const resolved = await realpath(target);
        if (inside(resolved) && (await stat(resolved)).size >= 12) files.push(path.relative(root, target).split(path.sep).join('/'));
      }
    }
  }
  await walk(path.join(root, 'data')); await walk(path.join(root, 'outputs'));
  const requested = new Set(), fingerprints = {};
  try {
    const text = (await readFile(path.join(root, 'results/metrics/stoi_estoi.json'), 'utf8')).replace(/^\uFEFF/, '');
    const payload = JSON.parse(text), rows = Array.isArray(payload) ? payload : payload.metrics;
    for (const row of rows || []) for (const key of ['reference_path', 'compared_path']) if (typeof row?.[key] === 'string' && files.includes(row[key])) requested.add(row[key]);
  } catch { /* Unavailable results do not validate any input. */ }
  for (const relative of requested) {
    try {
      const resolved = await realpath(path.join(root, relative));
      if (!inside(resolved)) continue;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(resolved)) hash.update(chunk);
      fingerprints[relative] = hash.digest('hex');
    } catch { /* Changed or missing files invalidate their scores. */ }
  }
  return { files: files.sort(), fingerprints };
}
