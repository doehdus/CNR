import { writeFile } from 'node:fs/promises';
import { SAMPLES, NOISE_SOURCES } from '../shared/research/dataset.js';

const manifest = { version: 1, samples: SAMPLES, noise_sources: NOISE_SOURCES.map(({ id, path }) => ({ id, path })) };
await writeFile(new URL('../public/data/metadata/dataset.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Registered ${SAMPLES.length} sample slots and ${NOISE_SOURCES.length} noise sources. No audio was generated.`);
