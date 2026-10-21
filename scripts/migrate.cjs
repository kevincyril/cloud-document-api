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
    // Print only known diagnostic codes and static hints, never provider messages,
    // connection strings, query details, or credentials.
    const hints = {
      SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain is not trusted. Configure DB_SSL_CA_FILE with the Supabase CA certificate.',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is not trusted. Configure DB_SSL_CA_FILE with the Supabase CA certificate.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate chain could not be verified. Check the Supabase CA certificate.',
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS issuer certificate is missing. Check the Supabase CA certificate.',
      CERT_HAS_EXPIRED: 'TLS certificate has expired. Check the configured CA certificate and provider certificate.',
      ERR_TLS_CERT_ALTNAME_INVALID: 'TLS hostname does not match the certificate. Check DB_HOST.',
      ENOTFOUND: 'Database hostname could not be resolved. Check DB_HOST.',
      EAI_AGAIN: 'Database DNS lookup temporarily failed.',
      ECONNREFUSED: 'Database connection was refused. Check host, port, and project status.',
      ETIMEDOUT: 'Database connection timed out. Check network access and project status.',
      ECONNRESET: 'Database connection was reset before migration completed.',
      '28P01': 'Database authentication failed. Check the database password and pooler username.',
      '28000': 'Database authorization failed. Check the database user and pooler configuration.',
      '3D000': 'Database does not exist. Check DB_NAME.',
      '42501': 'Database role lacks permission to apply the migrations.',
      '42P01': 'A table required by a migration is missing.',
      '42P07': 'A migration tried to create a table that already exists.',
      '42601': 'A migration contains invalid SQL syntax.',
      '53300': 'Database connection limit reached.',
    };
    const safe = /^(Existing tables|Baseline refused|Previously applied migration changed)/.test(error.message);
    console.error(safe ? error.message : 'Migration failed; verify database access and migration SQL. No changes were committed.');
    if (Object.hasOwn(hints, error.code)) {
      console.error(`Database diagnostic ${error.code}: ${hints[error.code]}`);
    }
    process.exitCode = 1;
  }).finally(() => pool.end());
}
