require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { pool } = require('../src/database.ts');
const { migrate } = require('./migrations.cjs');

test('migration baseline, rollback, and checksum protection', { timeout: 20000 }, async t => {
  const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
  // pg intentionally makes credentials non-enumerable; preserve them explicitly.
  const isolated = new Pool({ ...pool.options, password: pool.options.password,
    ssl: pool.options.ssl, options: `-c search_path=${schema},pg_catalog` });
  let created = false;
  try {
    assert.match(schema, /^migration_test_[a-f0-9]{32}$/);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await t.test('refuses an incomplete baseline and rolls back tracking table creation', async () => {
      await assert.rejects(migrate(isolated, { baselineExisting: true, log: () => {} }), /expected tables\/columns are missing/);
      const tracker = await isolated.query("SELECT to_regclass('schema_migrations') AS name");
      assert.equal(tracker.rows[0].name, null);
    });
    for (const file of ['001_create_users.sql', '002_create_documents.sql', '003_add_document_processing.sql']) {
      await isolated.query(await readFile(path.resolve(__dirname, '../database/migration', file), 'utf8'));
    }
    await t.test('refuses automatic migration over manually initialized tables', async () => {
      await assert.rejects(migrate(isolated, { log: () => {} }), /Existing tables have no migration history/);
    });
    await t.test('explicit baseline preserves existing rows and applies later migrations', async () => {
      const id = randomUUID();
      await isolated.query("INSERT INTO users (id, name, email, password_hash) VALUES ($1, 'Baseline fixture', $2, 'unused-test-hash')", [id, `${id}@example.com`]);
      await migrate(isolated, { baselineExisting: true, log: () => {} });
      assert.equal((await isolated.query('SELECT id FROM users WHERE id = $1', [id])).rowCount, 1);
      assert.equal((await isolated.query('SELECT name FROM schema_migrations')).rowCount, 6);
      await assert.rejects(migrate(isolated, { baselineExisting: true, log: () => {} }), /migration history already exists/);
      await migrate(isolated, { log: () => {} });
    });
    await t.test('changed historical migration checksum is refused', async () => {
      await isolated.query("UPDATE schema_migrations SET checksum = 'changed' WHERE name = '001_create_users.sql'");
      await assert.rejects(migrate(isolated, { log: () => {} }), /Previously applied migration changed/);
    });
  } finally {
    await isolated.end();
    try {
      if (created) {
        assert.match(schema, /^migration_test_[a-f0-9]{32}$/);
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally { await pool.end(); }
  }
});
