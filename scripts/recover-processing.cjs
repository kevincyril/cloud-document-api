// Never run while any API instance is serving requests.
require('tsx/cjs');
const { pool } = require('../src/database.ts');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-api-stopped') {
    console.error('Stop ALL API instances, then run: npm run db:recover-processing -- --confirm-api-stopped');
    process.exitCode = 1;
    return;
  }
  const result = await pool.query(`UPDATE documents SET status = 'failed',
    extracted_text = NULL, word_count = NULL, character_count = NULL,
    processed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing'`);
  console.log(`Recovered ${result.rowCount} interrupted processing attempt(s). Owners can retry.`);
}
main().catch(() => { console.error('Recovery failed; check database access.'); process.exitCode = 1; }).finally(() => pool.end());
