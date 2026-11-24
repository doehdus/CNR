import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localPath } from '../../shared/research/dataset.js';

export function projectPath(root, relative) {
  if (typeof relative !== 'string' || !relative || /[:\\]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('연구 경로는 프로젝트 내부 상대 경로여야 합니다.');
  }
  const target = path.resolve(root, relative), fromRoot = path.relative(root, target);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw new Error('연구 경로가 프로젝트 밖을 가리킵니다.');
  return target;
}

export async function loadProjectLayout(root) {
  const layout = JSON.parse((await readFile(projectPath(root, 'export/paths.json'), 'utf8')).replace(/^\uFEFF/, ''));
  if (layout.version !== 1 || !Array.isArray(layout.audio_roots) || !layout.audio_roots.length) throw new Error('연구 경로 설정 version 1이 필요합니다.');
  projectPath(root, layout.manifest);
  projectPath(root, layout.metric_results);
  const seen = new Set();
  for (const entry of layout.audio_roots) {
    projectPath(root, entry.source);
    projectPath(root, entry.public);
    if (!/^(?:data\/(?:clean|noise|mixed)|outputs)$/.test(entry.public) || seen.has(entry.public)) throw new Error('공개 음원 경로 설정을 확인하세요.');
    seen.add(entry.public);
  }
  return layout;
}

// Public paths are stable identifiers used by saved QR sessions and metrics.
export function sourceAudioPath(root, logicalPath, layout) {
  const relative = localPath(logicalPath);
  const entry = layout.audio_roots.find(entry => relative.startsWith(entry.public + '/'));
  if (!entry) throw new Error('등록된 연구 음원 경로가 아닙니다: ' + relative);
  return projectPath(root, entry.source + relative.slice(entry.public.length));
}
