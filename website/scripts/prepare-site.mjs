import { prepareBackend } from './prepare-backend.mjs';
import { prepareFrontend } from './prepare-frontend.mjs';

await prepareBackend();
await prepareFrontend();
console.log('Prepared frontend assets and backend data snapshots.');
