// Never run while any API instance is serving requests.
require('tsx/cjs');
const { pool } = require('../src/database.ts');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-api-stopped') {
    console.error('Stop ALL API instances, then run: npm run db:recover-processing -- --confirm-api-stopped');
    process.exitCode = 1;
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`WITH recovered AS (UPDATE documents SET status = 'failed',
      extracted_text = NULL, word_count = NULL, character_count = NULL,
      processed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' RETURNING id),
      removed AS (DELETE FROM document_pages WHERE document_id IN (SELECT id FROM recovered))
      SELECT count(*)::int AS count FROM recovered`);
    await client.query('COMMIT');
    console.log(`Recovered ${result.rows[0].count} interrupted processing attempt(s). Owners can retry.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
main().catch(() => { console.error('Recovery failed; check database access.'); process.exitCode = 1; }).finally(() => pool.end());
