const expectedIds = new Set(['instruction', 'warning'].flatMap(category => Array.from({ length: 6 }, (_, index) => category + String(index + 1).padStart(2, '0'))));
const fail = () => { throw new Error('실험 자료의 원음 ID·화자·파일 지문·녹음 정보를 확인하세요.'); };

export function normalizeCleanCollection(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.recordings) || input.recordings.length !== 12) fail();
  const seen = new Set();
  const recordings = input.recordings.map(row => {
    if (!row || !expectedIds.has(row.id) || seen.has(row.id)) fail();
    seen.add(row.id);
    const category = row.id.slice(0, -2), number = Number(row.id.slice(-2));
    if (row.category !== category || row.speaker !== (number <= 3 ? '유채원' : '김도연') || typeof row.text !== 'string' || !row.text.trim()) fail();
    if (row.path !== 'data/clean/' + row.id + '.wav' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) fail();
    if (![row.size, row.sample_rate_hz, row.sample_count].every(value => Number.isSafeInteger(value) && value > 0) || row.size < 44 || row.size > 25 * 1024 * 1024 || row.channels !== 1) fail();
    if (typeof row.duration_seconds !== 'number' || !Number.isFinite(row.duration_seconds) || Math.abs(row.duration_seconds - row.sample_count / row.sample_rate_hz) > 1e-9) fail();
    return { id: row.id, category, label: (category === 'instruction' ? '작업 지시 ' : '위험 경고 ') + number,
      speaker: row.speaker, text: row.text.trim(), path: row.path, sha256: row.sha256, size: row.size,
      sample_rate_hz: row.sample_rate_hz, sample_count: row.sample_count, channels: row.channels, duration_seconds: row.duration_seconds };
  });
  return { version: 1, recordings: recordings.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function collectionMatches(recording, fingerprints) {
  return fingerprints[recording.path] === recording.sha256;
}
