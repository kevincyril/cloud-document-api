const SwaggerParser = require('@apidevtools/swagger-parser');
const YAML = require('yaml');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  await SwaggerParser.validate(path.join(root, 'docs/openapi.json'), { resolve: { external: false } });
  const render = YAML.parse(await readFile(path.join(root, 'render.yaml'), 'utf8'));
  assert.equal(render.services.length, 1);
  assert.equal(render.services[0].plan, 'free');
  assert.equal(render.services[0].autoDeployTrigger, 'off');
  for (const name of ['DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const variable = render.services[0].envVars.find(entry => entry.key === name);
    assert.equal(variable.sync, false);
    assert.equal(variable.value, undefined);
  }
  const ci = YAML.parse(await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert.ok('push' in ci.on && 'pull_request' in ci.on);
  assert.equal(ci.permissions.contents, 'read');
  console.log('PASS: OpenAPI schema, deployment YAML, and CI YAML are valid.');
}
main().catch(() => { console.error('Documentation/configuration validation failed.'); process.exitCode = 1; });
