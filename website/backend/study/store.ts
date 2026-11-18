import { normalizeBackup } from '../../shared/research/evaluation.js';

export const EMPTY_STUDY = { version: 1, paths: {}, noise_paths: {}, metrics: [], ratings: [] };

export async function loadStudy(db: D1Database) {
  const record = await db.prepare('SELECT revision, payload, updated_at FROM study_state WHERE id = ?')
    .bind('study').first<{ revision: number; payload: string; updated_at: string }>();
  return record
    ? { revision: record.revision, state: normalizeBackup(JSON.parse(record.payload)), updated_at: record.updated_at }
    : { revision: 0, state: structuredClone(EMPTY_STUDY), updated_at: null };
}

export function initializeStudy(db: D1Database, now: string) {
  return db.prepare('INSERT INTO study_state (id, revision, payload, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind('study', JSON.stringify(EMPTY_STUDY), now);
}

export function advanceStudyIfChanged(db: D1Database, now: string) {
  return db.prepare('UPDATE study_state SET revision = revision + 1, updated_at = ? WHERE id = ? AND changes() > 0')
    .bind(now, 'study');
}
