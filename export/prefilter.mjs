import { researchPath } from './research_paths.mjs';
// Verify and deliver completed C-filtered WAVs. No filtering runs in this module.
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeFixedPrefilter } from '../website/shared/research/prefilter-fixed-data.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function checked(root, relative, expected) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part.startsWith('.')) || relative.includes(':')) throw Error('Invalid prefilter artifact path.');
  const target = researchPath(root, relative);
  if (!target.startsWith(root + path.sep) || await realpath(target) !== target) throw Error('Prefilter artifacts must stay inside the project.');
  const bytes = await readFile(target);
  if (digest(bytes) !== expected) throw Error('Prefilter artifact changed: ' + relative);
  return bytes;
}
export function sampleCount(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error('Invalid filtered WAV.');
  let format = false, count = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size + size % 2 > bytes.length) throw Error('Invalid WAV chunk.');
    if (id === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt16LE(start + 14) !== 16) throw Error('Expected 16kHz mono PCM16.');
      format = true;
    }
    if (id === 'data') { if (count !== null || size % 2) throw Error('Invalid WAV data.'); count = size / 2; }
    offset = start + size + size % 2;
  }
  if (!format || !count) throw Error('Incomplete WAV.');
  return count;
}
export async function loadFixedPrefilter(root, { metadataOnly = false } = {}) {
  root = await realpath(root);
  let pointer;
  try { pointer = JSON.parse(await readFile(researchPath(root, 'experiment/prefilter_results.json'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const bytes = await checked(root, pointer.manifest, pointer.sha256);
  const data = normalizeFixedPrefilter(JSON.parse(bytes));
  const config = await checked(root, 'code/config/prefilter_fixed.json', data.config_sha256);
  if (JSON.stringify(JSON.parse(config)) !== JSON.stringify(data.settings)) throw Error('Filtered audio uses different EQ settings.');
  await checked(root, data.design_manifest, data.design_manifest_sha256);
  const files = [];
  if (metadataOnly) return { data, files, sha256: digest(bytes) };
  for (const row of data.conditions) {
    for (const [logical, expected, physical] of [
      [row.input_path, row.input_sha256, 'data/mixtures/' + row.input_path.slice('data/mixed/'.length)],
      [row.output_path, row.output_sha256, 'experiment/post/' + row.output_path.slice('outputs/'.length)],
    ]) {
      const content = await checked(root, physical, expected);
      if (sampleCount(content) !== row.sample_count || logical === row.output_path && content.length !== row.size) throw Error('Input/output WAV length mismatch.');
      files.push({ path: logical, sha256: expected, size: content.length, bytes: content });
    }
  }
  return { data, files, sha256: digest(bytes) };
}
export async function deliverFixedPrefilter(result, destination, { metadataOnly = false } = {}) {
  for (const file of metadataOnly ? [] : result.files) {
    const target = path.join(destination, 'audio', file.path);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.bytes);
  }
  await mkdir(path.join(destination, 'prefilter'), { recursive: true });
  await writeFile(path.join(destination, 'prefilter/results.json'), JSON.stringify(metadataOnly ? { ...result.data, archived: true } : result.data) + '\n');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), root = args[args.indexOf('--root') + 1], destination = args[args.indexOf('--destination') + 1];
  const metadataOnly = args.includes('--metadata-only');
  const result = await loadFixedPrefilter(root, { metadataOnly });
  if (result) await deliverFixedPrefilter(result, destination, { metadataOnly });
  console.log(JSON.stringify({ count: result?.data.actual_count || 0, files: metadataOnly ? [] : result?.files.map(({ bytes: _bytes, ...file }) => file) || [] }));
}
