import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Self-contained fixtures also work in the standalone hosted Site checkout.
export async function writeTestLayout(root) {
  const layout = {
    version: 1,
    manifest: 'experiment/data/metadata/dataset.json',
    metric_results: 'experiment/outputs/metrics.json',
    audio_roots: [
      { public: 'data/clean', source: 'experiment/data/clean' },
      { public: 'data/noise', source: 'experiment/data/noise' },
      { public: 'data/mixed', source: 'experiment/data/mixtures' },
      { public: 'outputs', source: 'experiment/outputs/enhanced' },
    ],
  };
  await mkdir(path.join(root, 'experiment/config'), { recursive: true });
  await writeFile(path.join(root, 'experiment/config/paths.json'), JSON.stringify(layout));
  return layout;
}
