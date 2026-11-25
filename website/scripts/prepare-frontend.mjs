import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSurvey } from './prepare-survey.mjs';
import { prepareAudio } from './prepare-audio.mjs';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const sharedModules = ['dataset.js', 'evaluation.js', 'metrics.js', 'correlation.js', 'report.js', 'study-tables.js', 'noise-analysis-data.js', 'peak-analysis-data.js', 'mixture-summary-data.js', 'prefilter-data.js', 'prefilter-fixed-data.js', 'prefilter-bpf-data.js', 'prefilter-metrics-data.js', 'prefilter-listening-data.js', 'collection-data.js', 'ss-fixed-data.js'];
export const frontendAssets = [
  ['collection/index.html', 'website/index.html'],
  ['collection/style.css', 'website/css/style.css'],
  ['collection/files.js', 'website/js/files.js'],
  ['collection/clean-library.js', 'website/js/clean-library.js'],
  ['collection/favicon.svg', 'favicon.svg'],
  ['comparison/ss-fixed.js', 'website/js/ss-fixed.js'],
  ['comparison/ss-fixed.css', 'website/css/ss-fixed.css'],
  ['comparison/audio-comparison.js', 'website/js/audio-comparison.js'],
  ['comparison/graphs.js', 'website/js/graphs.js'],
  ['comparison/peak-analysis.js', 'website/js/peak-analysis.js'],
  ['comparison/noise-analysis.js', 'website/js/noise-analysis.js'],
  ['comparison/mixture-summary.js', 'website/js/mixture-summary.js'],
  ['comparison/prefilter.js', 'website/js/prefilter.js'],
  ['comparison/butterworth-prefilter.js', 'website/js/butterworth-prefilter.js'],
  ['comparison/prefilter-analysis.js', 'website/js/prefilter-analysis.js'],
  ['comparison/prefilter-listening.js', 'website/js/prefilter-listening.js'],
  ['listening-test/prefilter-survey.html', 'website/prefilter-survey.html'],
  ['listening-test/prefilter-survey.js', 'website/js/prefilter-survey.js'],
  ['listening-test/prefilter-listening.css', 'website/css/prefilter-listening.css'],
  ['listening-test/survey.html', 'website/survey.html'],
  ['listening-test/survey-admin.html', 'website/survey-admin.html'],
  ['listening-test/survey.css', 'website/css/survey.css'],
  ...['survey-common', 'survey-admin', 'survey-participant'].map(name => [`listening-test/${name}.js`, `website/js/${name}.js`]),
];

// Only explicitly public research modules enter the browser asset tree.
export async function prepareFrontend({ development = false } = {}) {
  const audioCatalog = await prepareAudio(siteRoot);
  const publishedAudio = new Set(audioCatalog.files.map(file => file.path));
  const sourceAudioRoot = path.join(siteRoot, 'public/dataset/audio');
  const runtimeRoot = path.join(siteRoot, '.sites-runtime');
  await mkdir(runtimeRoot, { recursive: true });
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error('Runtime files must stay inside this Site.');
  const publicRoot = path.join(runtimeRoot, 'public');
  try {
    if (await realpath(publicRoot) !== publicRoot) throw new Error('Generated assets must stay inside this Site.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(path.join(runtimeRoot, 'public-'));
  try {
    for (const [source, destination] of frontendAssets) {
      await mkdir(path.dirname(path.join(stage, destination)), { recursive: true });
      await cp(path.join(siteRoot, 'src', source), path.join(stage, destination));
      if (development && destination.endsWith('.html')) {
        const target = path.join(stage, destination);
        await writeFile(target, (await readFile(target, 'utf8')).replace('</head>', '<script type="module" src="/@vite/client"></script></head>'));
      }
    }
    for (const name of sharedModules) {
      await cp(path.join(siteRoot, 'shared/research', name), path.join(stage, 'website/js', name));
    }
    for (const name of ['dataset']) {
      try {
        await cp(path.join(siteRoot, 'public', name), path.join(stage, name), { recursive: true,
          filter: source => {
            const relative = path.relative(sourceAudioRoot, source);
            if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return true;
            if (relative === 'catalog.json') return false;
            return !relative.toLowerCase().endsWith('.wav') || publishedAudio.has(relative.split(path.sep).join('/'));
          },
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await mkdir(path.join(stage, 'dataset/audio'), { recursive: true });
    await writeFile(path.join(stage, 'dataset/audio/catalog.json'), JSON.stringify(audioCatalog) + '\n');
    await prepareSurvey(stage);
    // Both paths are resolved beneath the verified runtime directory above.
    await rm(publicRoot, { recursive: true, force: true });
    try {
      await rename(stage, publicRoot);
    } catch (error) {
      // Windows can deny directory renames while individual files remain readable.
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      await cp(stage, publicRoot, { recursive: true });
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await prepareFrontend();
  console.log('Prepared frontend assets in .sites-runtime/public/.');
}
