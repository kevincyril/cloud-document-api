// Run against the local API: node scripts/verify-pdf.cjs
// Creates temporary accounts and files, then removes only those test resources.
require('tsx/cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { pool } = require('../src/database.ts');
const { deleteFile } = require('../src/services/storage.ts');

function createPdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Cloud PDF round trip test) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main() {
  const users = [];
  const keys = [];
  const base = 'http://localhost:3000';
  async function request(path, options = {}) {
    const response = await fetch(base + path, options);
    return { response, body: await response.json() };
  }
  try {
    for (let i = 0; i < 2; i++) {
      const credentials = { email: `pdf-check-${randomUUID()}@example.com`, password: randomUUID() };
      const registered = await request('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'PDF verification', ...credentials }),
      });
      assert.equal(registered.response.status, 201);
      users.push({ id: registered.body.user.id });
      const login = await request('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
      });
      assert.equal(login.response.status, 200);
      users[i].headers = { Authorization: `Bearer ${login.body.token}` };
    }
    const pdf = createPdf();
    const form = new FormData();
    form.append('document', new Blob([pdf], { type: 'application/pdf' }), 'round-trip.pdf');
    const uploaded = await request('/documents/upload', { method: 'POST', headers: users[0].headers, body: form });
    assert.equal(uploaded.response.status, 201);
    const id = uploaded.body.document.id;
    const stored = await pool.query('SELECT storage_key FROM documents WHERE id = $1 AND user_id = $2', [id, users[0].id]);
    keys.push(stored.rows[0].storage_key);
    for (const path of [`/documents/${id}`, `/documents/${id}/download`, `/documents/${id}/process`]) {
      const response = await fetch(base + path, { method: path.endsWith('/process') ? 'POST' : 'GET', headers: users[1].headers });
      assert.equal(response.status, 404);
    }
    const processed = await request(`/documents/${id}/process`, { method: 'POST', headers: users[0].headers });
    assert.equal(processed.response.status, 200);
    assert.ok(processed.body.analysis.text.includes('Cloud PDF round trip test'));
    assert.equal(processed.body.analysis.wordCount, 5);
    assert.ok(!processed.body.analysis.text.includes('-- 1 of 1 --'));
    const metadata = await request(`/documents/${id}`, { headers: users[0].headers });
    assert.equal(metadata.response.status, 200);
    assert.equal(metadata.body.document.status, 'completed');
    assert.equal(metadata.body.document.extracted_text, processed.body.analysis.text);
    assert.equal(metadata.body.document.word_count, processed.body.analysis.wordCount);
    assert.equal(metadata.body.document.character_count, processed.body.analysis.characterCount);
    assert.ok(metadata.body.document.processed_at);
    const download = await fetch(`${base}/documents/${id}/download`, { headers: users[0].headers });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    const invalidForm = new FormData();
    invalidForm.append('document', new Blob(['%PDF-1.4\nDamaged PDF body'], { type: 'application/pdf' }), 'invalid.pdf');
    const invalidUpload = await request('/documents/upload', { method: 'POST', headers: users[0].headers, body: invalidForm });
    assert.equal(invalidUpload.response.status, 201);
    const invalidId = invalidUpload.body.document.id;
    const rejected = await request(`/documents/${invalidId}/process`, { method: 'POST', headers: users[0].headers });
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.body.message, 'The PDF is invalid or damaged');
    const failed = await request(`/documents/${invalidId}`, { headers: users[0].headers });
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body.document.status, 'failed');
    for (const field of ['extracted_text', 'word_count', 'character_count', 'processed_at']) {
      assert.equal(failed.body.document[field], null);
    }
    console.log('PASS: PDF upload, extraction, persisted metadata, download, and ownership isolation.');
    console.log('PASS: Invalid PDF returns JSON 422 and persists failed status without results.');
    console.log('Extracted generated fixture:', JSON.stringify(processed.body.analysis));
  } finally {
    // Collect every upload for these temporary users, even if an assertion failed.
    for (const user of users) {
      const result = await pool.query('SELECT storage_key FROM documents WHERE user_id = $1', [user.id]);
      for (const row of result.rows) if (!keys.includes(row.storage_key)) keys.push(row.storage_key);
    }
    for (const key of keys) await deleteFile(key);
    for (const user of users) await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await pool.end();
  }
}

main().catch(() => {
  console.error('PDF verification failed; check the local API and database, then rerun.');
  process.exitCode = 1;
});
