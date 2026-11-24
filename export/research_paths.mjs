import path from 'node:path';
import { existsSync } from 'node:fs';

// An explicitly supplied historical workspace keeps its original wire paths.
// Never search before1123 from the active workspace.
export function researchPath(root, ...parts) {
  let relative = path.posix.join(...parts);
  const legacy = existsSync(path.join(root, 'experiment/config/paths.json')) &&
    !existsSync(path.join(root, 'export/paths.json'));
  if (legacy && /^experiment\/(data|mixtures|config|outputs)(\/|$)/.test(relative)) {
    return path.join(root, relative);
  }
  const pairs = [
    ['experiment/src/evaluation', 'code/evaluation'],
    ['experiment/src/analysis', 'analysis/mkgraphs'],
    ['experiment/outputs/mixture_preparation', 'data/preparation'],
    ['experiment/outputs/mixture_summary', 'analysis/results/mixture_summary'],
    ['experiment/outputs/peak_analysis', 'analysis/results/peak_analysis'],
    ['experiment/outputs/noise_analysis', 'analysis/results/noise_analysis'],
    ['experiment/outputs/enhanced', 'experiment/post'],
    ['experiment/config', 'code/config'],
    ['experiment/mixtures', 'data/mixtures'],
    ['experiment/data', 'data'],
    ['experiment/outputs', 'experiment'],
  ];
  for (const [oldPath, newPath] of pairs) {
    const from = legacy ? newPath : oldPath, to = legacy ? oldPath : newPath;
    if (relative === from || relative.startsWith(from + '/')) {
      relative = to + relative.slice(from.length);
      break;
    }
  }
  return path.join(root, relative);
}
