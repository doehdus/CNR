import path from 'node:path';
import type { Plugin } from 'vite';
import { prepareFrontend } from '../prepare-frontend.mjs';
import { prepareBackend } from '../prepare-backend.mjs';

// Authored vanilla pages are copied into the public snapshot. Refresh that snapshot on edits.
export function authoredAssets(): Plugin {
  return {
    name: 'cnr-authored-assets',
    apply: 'serve',
    configureServer(server) {
      const directories = ['src/collection', 'src/comparison', 'src/listening-test', 'shared/research'].map(relative => path.resolve(server.config.root, relative));
      let timer: ReturnType<typeof setTimeout> | undefined, pending = Promise.resolve();
      const update = (filename: string) => {
        const absolute = path.resolve(filename);
        if (!directories.some(directory => absolute.startsWith(directory + path.sep))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending = pending.then(async () => {
            await prepareBackend();
            await prepareFrontend({ development: true });
            server.ws.send({ type: 'full-reload' });
          }).catch(error => server.config.logger.error('Frontend refresh failed: ' + error.message));
        }, 120);
      };
      server.watcher.add(directories);
      server.watcher.on('change', update).on('add', update).on('unlink', update);
      server.httpServer?.once('close', () => { clearTimeout(timer); server.watcher.off('change', update).off('add', update).off('unlink', update); });
    },
  };
}
