import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import manifest from '../fixtures/before1123/manifest.json' with { type: 'json' };

// Historical metadata exercises existing behavior without becoming active study data.
export function readLegacyFixture(relative) {
  const expected = manifest.files[relative];
  if (!expected) throw new Error('Unregistered regression fixture: ' + relative);
  const content = gunzipSync(readFileSync(new URL('../fixtures/before1123/' + relative + '.gz', import.meta.url)));
  if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error('Regression fixture fingerprint differs.');
  return content.toString('utf8');
}
