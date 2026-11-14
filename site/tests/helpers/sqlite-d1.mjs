import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  function prepare(sql, values = []) {
    const execute = () => {
      const statement = sqlite.prepare(sql);
      if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 } };
      return { results: [], meta: { changes: Number(statement.run(...values).changes) } };
    };
    return {
      sql,
      bind: (...args) => prepare(sql, args),
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return execute(); },
      async run() { return execute(); },
      execute,
    };
  }
  const DB = {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { DB, sqlite, close: () => sqlite.close() };
}
