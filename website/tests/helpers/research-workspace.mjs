import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Self-contained fixtures also work in the standalone hosted Site checkout.
export async function writeTestLayout(root) {
  const layout = {
    version: 1,
    manifest: 'data/metadata/dataset.json',
    metric_results: 'experiment/evaluation/metrics.json',
    audio_roots: [
      { public: 'data/clean', source: 'data/clean' },
      { public: 'data/noise', source: 'data/noise' },
      { public: 'data/mixed', source: 'data/mixtures' },
      { public: 'outputs', source: 'experiment/post' },
    ],
  };
  await mkdir(path.join(root, 'export'), { recursive: true });
  await writeFile(path.join(root, 'export/paths.json'), JSON.stringify(layout));
  return layout;
}
