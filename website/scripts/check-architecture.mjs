import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(filename);
  }
  return files;
}

function importTarget(filename, specifier) {
  if (specifier.startsWith('.')) return path.resolve(path.dirname(filename), specifier);
  for (const [alias, directory] of [['@/', 'src'], ['@backend/', 'backend'], ['@shared/', 'shared']]) {
    if (specifier.startsWith(alias)) return path.join(siteRoot, directory, specifier.slice(alias.length));
  }
  return null;
}

// worker.ts is the composition root. Feature code must respect these boundaries.
export async function checkArchitecture() {
  const violations = [];
  for (const layer of ['src', 'backend', 'shared']) {
    for (const filename of await sourceFiles(path.join(siteRoot, layer))) {
      const relative = path.relative(siteRoot, filename).split(path.sep).join('/');
      const text = await readFile(filename, 'utf8');
      for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
        const target = importTarget(filename, specifier);
        const destination = target && path.relative(siteRoot, target).split(path.sep)[0];
        if ((layer === 'backend' && destination === 'src') ||
            (layer === 'src' && destination === 'backend') ||
            (layer === 'shared' && ['src', 'backend'].includes(destination))) {
          violations.push(`${relative}: ${layer} cannot import ${specifier}`);
        }
        if (layer === 'shared' && /^(?:node:|cloudflare:|next(?:\/|$)|react(?:\/|$))/.test(specifier)) {
          violations.push(`${relative}: shared code cannot depend on ${specifier}`);
        }
      }
      if (layer === 'shared') {
        const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
          if (ts.isIdentifier(node) && ['document', 'window', 'localStorage', 'sessionStorage'].includes(node.text)) {
            violations.push(`${relative}: shared code cannot use browser global ${node.text}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  return violations;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const violations = await checkArchitecture();
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Architecture boundaries verified: src / backend / shared.');
  }
}
