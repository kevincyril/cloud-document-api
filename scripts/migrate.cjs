require('tsx/cjs');
const { pool } = require('../src/database.ts');
const { migrate } = require('./migrations.cjs');
const baselineExisting = process.argv.includes('--baseline-existing');
if (process.argv.slice(2).some(arg => arg !== '--baseline-existing')) {
  console.error('Usage: npm run db:migrate [-- --baseline-existing]');
  process.exitCode = 1;
  void pool.end();
} else {
  migrate(pool, { baselineExisting }).catch(error => {
    // Only our own migration guidance is safe to print, never database details.
    const safe = /^(Existing tables|Baseline refused|Previously applied migration changed)/.test(error.message);
    console.error(safe ? error.message : 'Migration failed; verify database access and migration SQL. No changes were committed.');
    process.exitCode = 1;
  }).finally(() => pool.end());
}
