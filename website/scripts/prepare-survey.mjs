import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function prepareSurvey(publicRoot) {
  const target = path.join(publicRoot, 'website/vendor');
  await mkdir(target, { recursive: true });
  await copyFile(new URL('../node_modules/qrcode-generator/dist/qrcode.mjs', import.meta.url), path.join(target, 'qrcode.mjs'));
}
