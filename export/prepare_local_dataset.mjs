import { loadPeakAnalysis } from './peak_analysis.mjs';
import { loadFixedPrefilter, deliverFixedPrefilter } from './prefilter.mjs';
import { loadBpfPrefilter, deliverBpfPrefilter } from './bpf.mjs';
import { loadMixtureSummary, deliverMixtureSummary } from './mixture_summary.mjs';
// Deliver the shared inputs and previously calculated reference plots; no FFT or metrics run here.
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeCleanCollection } from '../website/shared/research/collection-data.js';
import { normalizeNoiseAnalysis, noiseAnalysisImages } from '../website/shared/research/noise-analysis-data.js';
import { peakSourcePath } from '../website/shared/research/peak-analysis-data.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
const writeJSON = (filename, data) => writeFile(filename, JSON.stringify(data, null, 2) + '\n');
async function optionalJSON(filename) { try { return await json(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

function inside(root, relative) {
  if (typeof relative !== 'string' || /[:\\?#%\x00]/.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) throw new Error('A project-relative data path is required.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('Data must stay inside the repository.');
  return target;
}

export function waveMetadata(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('A RIFF/WAVE input is required.');
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length) throw new Error('Truncated RIFF input.');
  let format, dataBytes;
  for (let start = 12; start + 8 <= end;) {
    const type = bytes.toString('ascii', start, start + 4), size = bytes.readUInt32LE(start + 4), offset = start + 8;
    if (offset + size + (size % 2) > end) throw new Error('Truncated WAV chunk.');
    if (type === 'fmt ') {
      const code = size >= 16 ? bytes.readUInt16LE(offset) : 0;
      const extendedPCM = code === 65534 && size >= 40 && bytes.readUInt16LE(offset + 16) >= 22 &&
        bytes.subarray(offset + 24, offset + 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex'));
      if (format || size < 16 || code !== 1 && !extendedPCM) throw new Error('Expected a PCM WAV format.');
      format = { channels: bytes.readUInt16LE(offset + 2), sample_rate_hz: bytes.readUInt32LE(offset + 4), bits: bytes.readUInt16LE(offset + 14) };
    }
    if (type === 'data') { if (dataBytes !== undefined) throw new Error('Multiple WAV data chunks.'); dataBytes = size; }
    start = offset + size + size % 2;
  }
  if (!format || format.channels !== 1 || format.bits !== 16 || !format.sample_rate_hz || !dataBytes || dataBytes % 2) throw new Error('Shared inputs must be complete mono PCM16 WAVs.');
  return { channels: 1, sample_rate_hz: format.sample_rate_hz, sample_count: dataBytes / 2, duration_seconds: dataBytes / 2 / format.sample_rate_hz };
}

export async function prepareLocalDataset(root = projectRoot) {
  root = await realpath(root);
  const definition = await json(inside(root, 'data/metadata/collection.json'));
  const manifest = await json(inside(root, 'data/metadata/dataset.json'));
  const inputFiles = new Map(), recordings = [];
  async function input(relative, logical) {
    const source = inside(root, relative);
    if (await realpath(source) !== source) throw new Error('Shared input files must not be symlinks.');
    const bytes = await readFile(source);
    let metadata;
    try { metadata = waveMetadata(bytes); } catch (error) { throw new Error(relative + ': ' + error.message); }
    inputFiles.set(logical, { bytes, path: logical, sha256: sha256(bytes), size: bytes.length });
    return metadata;
  }
  for (const row of definition.recordings) {
    const logical = 'data/clean/' + row.id + '.wav';
    const metadata = await input(definition.source_root + '/' + row.id + '.wav', logical);
    const { sha256: fingerprint, size } = inputFiles.get(logical);
    recordings.push({ ...row, path: logical, sha256: fingerprint, size, ...metadata });
  }
  normalizeCleanCollection({ version: 1, recordings });
  for (const noise of manifest.noise_sources) await input(noise.path, noise.path);
  if (inputFiles.size !== 15) throw new Error('Expected twelve shared clean recordings and three noises.');
  // Retained inputs are independent of previous analysis and processing outputs.
  const registry = await optionalJSON(inside(root, 'data/metadata/inputs.json'));
  if (registry) {
    if (registry.version !== 1 || !Array.isArray(registry.files) || registry.files.length !== registry.expected_count) throw new Error('Registered input count differs.');
    const seen = new Set();
    for (const file of registry.files) {
      if (seen.has(file.path) || peakSourcePath(file.path) !== file.source) throw new Error('Registered input source differs or is duplicated.');
      seen.add(file.path);
      await input(file.source, file.path);
      const actual = inputFiles.get(file.path);
      if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new Error('Registered input changed: ' + file.path);
    }
    if (inputFiles.size !== registry.expected_count) throw new Error('Input registry does not cover the current collection.');
  }
  const peakAnalysis = await loadPeakAnalysis(root);
  const mixtureSummary = await loadMixtureSummary(root);
  const bpf = await loadBpfPrefilter(root);
  const prefilter = await loadFixedPrefilter(root, { metadataOnly: Boolean(bpf) });
  if (prefilter && !bpf) for (const file of prefilter.files) {
    if (inputFiles.has(file.path) && inputFiles.get(file.path).sha256 !== file.sha256) throw new Error('Prefilter input fingerprint conflict.');
    inputFiles.set(file.path, file);
  }
  if (bpf) for (const file of bpf.files) {
    if (inputFiles.has(file.path) && inputFiles.get(file.path).sha256 !== file.sha256) throw new Error('BPF input fingerprint conflict.');
    inputFiles.set(file.path,file);
  }
  if (peakAnalysis) for (const { bytes, path: logical, sha256, size } of peakAnalysis.files) {
    if (inputFiles.has(logical) && inputFiles.get(logical).sha256 !== sha256) throw new Error('Peak analysis input conflict.');
    inputFiles.set(logical, { bytes, path: logical, sha256, size });
  }
  const referenceRoot = inside(root, 'analysis/results/noise_analysis');
  const reference = await optionalJSON(path.join(referenceRoot, 'results.json'));
  const sourceFingerprint = sha256(JSON.stringify([definition, manifest, [...inputFiles.values()].map(({ path, sha256 }) => [path, sha256]), reference, peakAnalysis?.sha256 || null, mixtureSummary?.sha256 || null, prefilter?.sha256 || null, bpf?.sha256 || null, bpf?.metrics?.sha256 || null, bpf?.listening?.sha256 || null]));
  const publicRoot = inside(root, 'website/public');
  const destination = path.join(publicRoot, 'dataset');
  await mkdir(publicRoot, { recursive: true });
  if (await realpath(publicRoot) !== publicRoot) throw new Error('Public data must stay inside this checkout.');
  const existing = await optionalJSON(path.join(destination, 'local-inputs.json'));
  if (existing?.source_sha256 === sourceFingerprint) return { recordings: 12, noises: 3, changed: false };
  const metrics = await optionalJSON(path.join(destination, 'results.json'));
  const oldCatalog = await optionalJSON(path.join(destination, 'audio/catalog.json'));
  if (metrics?.length || oldCatalog?.files?.some(file => !inputFiles.has(file.path))) {
    console.log('Preserved an existing experiment snapshot. Export new experiment results explicitly when changing its inputs.');
    return { changed: false, preserved: true };
  }
  if (oldCatalog && await realpath(destination) !== destination) throw new Error('Dataset must not be a symlink.');
  const stage = await mkdtemp(path.join(publicRoot, '.dataset-stage-local-'));
  const backup = path.join(publicRoot, '.dataset-backup-' + randomUUID());
  let installed = false;
  try {
    if (oldCatalog) await cp(destination, stage, { recursive: true, force: true });
    const files = [];
    for (const { bytes, ...file } of inputFiles.values()) {
      const target = inside(stage, 'audio/' + file.path);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); files.push(file);
    }
    await writeJSON(path.join(stage, 'audio/catalog.json'), { version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
    await writeJSON(path.join(stage, 'manifest.json'), manifest);
    await writeJSON(path.join(stage, 'collection.json'), { version: 1, recordings });
    await writeJSON(path.join(stage, 'results.json'), []);
    if (peakAnalysis) {
      // Rebuild this generated subtree from the complete verified reference map.
      // Historical research runs remain in experiment/, rather than accumulating in deployment.
      await rm(inside(stage, 'peak_analysis'), { recursive: true, force: true });
      await mkdir(path.join(stage, 'peak_analysis'), { recursive: true });
      for (const artifact of peakAnalysis.artifacts) {
        const target = inside(stage, 'peak_analysis/' + artifact.path);
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, artifact.bytes);
      }
      await writeJSON(path.join(stage, 'peak_analysis/results.json'), peakAnalysis.data);
    }
    await rm(inside(stage, 'mixture_summary'), { recursive: true, force: true });
    if (mixtureSummary) await deliverMixtureSummary(mixtureSummary, stage);
    if (prefilter) await deliverFixedPrefilter(prefilter, stage, { metadataOnly: Boolean(bpf) });
    if (bpf) await deliverBpfPrefilter(bpf, stage);
    await writeJSON(path.join(stage, 'export.json'), { version: 1, mode: 'local-inputs', audio_files: files.length, metric_rows: 0, clean_recordings: 12 });
    let graphs = 0;
    if (reference) {
      const normalized = normalizeNoiseAnalysis(reference);
      const inputsMatch = [...normalized.sources, normalized.overview].filter(Boolean).every(row => row.inputs.every(item => {
        const noise = manifest.noise_sources.find(noise => noise.id === item.sample_id);
        return noise && inputFiles.get(noise.path)?.sha256 === item.sha256;
      }));
      if (inputsMatch) {
        for (const image of noiseAnalysisImages(normalized)) {
          const source = inside(root, 'analysis/graphs/noise_analysis/' + image.slice('graphs/'.length));
          if (await realpath(source) !== source) throw new Error('Reference plots must not be symlinks.');
          const bytes = await readFile(source);
          if (sha256(bytes) !== reference.artifacts[image]) throw new Error('A reference plot changed since calculation.');
          const target = inside(stage, 'noise_analysis/' + image);
          await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); graphs++;
        }
        await writeJSON(path.join(stage, 'noise_analysis/results.json'), reference);
      } else {
        await rm(path.join(stage, 'noise_analysis/results.json'), { force: true });
        console.log('Noise inputs changed; reference FFT plots are withheld until a new analysis is exported.');
      }
    }
    await writeJSON(path.join(stage, 'local-inputs.json'), { version: 1, source_sha256: sourceFingerprint });
    if (oldCatalog) await rename(destination, backup);
    try {
      try { await rename(stage, destination); }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        await cp(stage, destination, { recursive: true, force: true });
      }
    } catch (error) {
      // Both paths are verified generated directories below publicRoot.
      await rm(destination, { recursive: true, force: true });
      if (oldCatalog) await rename(backup, destination);
      throw error;
    }
    installed = true;
    console.log('Prepared local inputs: 12 clean WAVs, 3 noises, ' + graphs + ' reference plots.');
    return { recordings: 12, noises: 3, graphs, changed: true };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (installed) await rm(backup, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  prepareLocalDataset().catch(error => { console.error(error.message); process.exitCode = 1; });
}
