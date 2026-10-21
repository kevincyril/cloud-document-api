const { readdir, readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');

async function migrate(pool, { baselineExisting = false, log = console.log } = {}) {
  const directory = path.resolve(__dirname, '../database/migration');
  const names = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(84216, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await client.query('SELECT name, checksum FROM schema_migrations');
    const known = new Map(applied.rows.map(row => [row.name, row.checksum]));
    for (const name of known.keys()) {
      if (!names.includes(name)) throw new Error(`Previously applied migration changed: missing ${name}`);
    }
    if (known.size === 0) {
      const tables = await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name IN ('users', 'documents')`);
      if (tables.rows.length && !baselineExisting) {
        throw new Error('Existing tables have no migration history. Review docs/setup.md before using --baseline-existing.');
      }
      if (baselineExisting) {
        const columns = await client.query(`SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name IN ('users', 'documents')`);
        const present = new Set(columns.rows.map(row => `${row.table_name}.${row.column_name}`));
        const expected = {
          users: ['id', 'name', 'email', 'password_hash', 'role', 'created_at', 'updated_at'],
          documents: ['id', 'user_id', 'original_name', 'mime_type', 'size_bytes', 'storage_key', 'status', 'created_at', 'updated_at', 'extracted_text', 'word_count', 'character_count', 'processed_at'],
        };
        for (const [table, fields] of Object.entries(expected)) {
          for (const field of fields) if (!present.has(`${table}.${field}`)) throw new Error('Baseline refused: expected tables/columns are missing.');
        }
      }
    } else if (baselineExisting) {
      throw new Error('Baseline refused: migration history already exists. Run without --baseline-existing.');
    }
    for (const name of names) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      if (known.has(name)) {
        if (known.get(name) !== checksum) throw new Error(`Previously applied migration changed: ${name}`);
        continue;
      }
      const baseline = baselineExisting && Number(name.slice(0, 3)) <= 3;
      if (!baseline) await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      log(`${baseline ? 'Recorded existing' : 'Applied'} ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { migrate };
