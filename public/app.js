'use strict';
const $ = id => document.getElementById(id);
let token = '', generation = 0, registration = false, offset = 0, selected = null, busy = false, expiryTimer, pollTimer;
const limit = 20;
let searchQuery = '', searchOffset = 0, searchHasMore = false;
function notice(message = '', error = false) {
  $('notice').textContent = message; $('notice').classList.toggle('error', error);
  if (error && message) $('notice').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function signOut(message = 'Signed out.') {
  window.ManagedAuth?.clear();
  window.ReceiptTracker?.reset();
  generation++; token = ''; selected = null; clearTimeout(expiryTimer); clearTimeout(pollTimer);
  $('workspace').hidden = true; $('auth').hidden = false; $('logout').hidden = true;
  $('documents').replaceChildren(); $('text').textContent = ''; $('result').hidden = true; $('empty').hidden = false;
  $('auth-form').reset(); $('upload-form').reset(); clearSearch(); notice(message);
}
async function request(path, options = {}, binary = false) {
  const current = generation;
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try { response = await fetch(path, { ...options, headers, cache: 'no-store' }); }
  catch { throw new Error('Connection interrupted. Refresh documents to check whether your action completed before retrying.'); }
  if (current !== generation) throw new Error('Session changed. Please try again.');
  if (response.status === 401 && token) { signOut('Your session expired. Sign in again.'); throw new Error('Your session expired. Sign in again.'); }
  if (binary && response.ok) { const blob = await response.blob(); if (current !== generation) throw new Error('Session changed. Please try again.'); return blob; }
  const body = await response.json().catch(() => ({}));
  if (current !== generation) throw new Error('Session changed. Please try again.');
  if (!response.ok) {
    const fields = [...Object.values(body.errors || {}).flat(), ...(body.issues || []).slice(0, 10).map(issue => `${issue.path?.join('.') || 'Input'}: ${issue.message}`)].join(' ');
    throw new Error(response.status === 429 ? 'Too many requests. Please wait a minute before trying again.' : `${body.message || `Request failed (${response.status}).`}${fields ? ' ' + fields : ''}`);
  }
  return body;
}
async function action(label, work) {
  if (busy) return;
  busy = true; const current = generation;
  document.querySelectorAll('button').forEach(b => { if (!['logout', 'ocr-cancel'].includes(b.id)) b.disabled = true; });
  $('workspace').setAttribute('aria-busy', 'true'); notice(label);
  try { await work(); } catch (error) { if (current === generation || !token) notice(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('workspace').removeAttribute('aria-busy'); updateControls(); }
}
function updateControls() {
  window.ReceiptTracker?.sync();
  $('previous').disabled = busy || offset === 0;
  $('next').disabled = busy || !$('documents').dataset.hasNext || offset >= 10000;
  $('process').disabled = busy || !selected || selected.status === 'processing' || !['application/pdf', 'text/plain'].includes(selected.mime_type);
  $('search-previous').disabled = busy || searchOffset === 0;
  $('search-next').disabled = busy || !searchHasMore;
}
async function list() {
  const body = await request(`/documents?limit=${limit}&offset=${offset}`);
  $('documents').replaceChildren(); $('documents').dataset.hasNext = body.documents.length === limit ? 'yes' : '';
  if (!body.documents.length) { const p = document.createElement('p'); p.textContent = offset ? 'No more documents on this page.' : 'Your library is empty. Add your first document above.'; $('documents').append(p); }
  for (const doc of body.documents) {
    const b = document.createElement('button'); b.className = 'doc'; b.setAttribute('aria-pressed', String(selected?.id === doc.id));
    const name = document.createElement('strong'); name.textContent = doc.original_name;
    const info = document.createElement('small'); info.textContent = `${doc.status} · ${new Date(doc.created_at).toLocaleDateString()}`;
    b.dataset.id = doc.id; b.append(name, info); b.onclick = () => action('Loading document…', async () => { await select(doc.id); notice(); }); $('documents').append(b);
  }
  $('page').textContent = `Page ${offset / limit + 1}`; updateControls();
}
async function select(id, unitIndex = null) {
  clearTimeout(pollTimer);
  const body = await request(`/documents/${encodeURIComponent(id)}`); selected = body.document;
  $('empty').hidden = true; $('result').hidden = false; $('document-name').textContent = selected.original_name;
  $('status').textContent = selected.status; $('document-info').textContent = `${(selected.size_bytes / 1024).toFixed(1)} KiB · ${selected.mime_type}`;
  $('words').textContent = selected.word_count == null ? '—' : Number(selected.word_count).toLocaleString();
  $('characters').textContent = selected.character_count == null ? '—' : Number(selected.character_count).toLocaleString();
  $('text-heading').textContent = 'Extracted text'; $('all-text').hidden = true;
  $('text').textContent = selected.extracted_text ?? 'Extracted text will appear here after processing.';
  if (unitIndex !== null) {
    const { unit } = await request(`/documents/${encodeURIComponent(id)}/units/${unitIndex}`);
    $('text').textContent = unit.text;
    $('text-heading').textContent = unit.page_number === null ? 'Source: text file' : `Source: PDF page ${unit.page_number}`;
    $('all-text').hidden = false;
  }
  $('process').textContent = selected.status === 'processing' ? 'Processing…' : selected.status === 'failed' ? 'Retry extraction' : selected.status === 'completed' ? 'Extract again' : 'Extract text';
  $('processing-help').textContent = selected.status === 'processing' ? 'Processing is running. Status refreshes every 5 seconds. An interrupted server may need operator recovery.' : selected.status === 'failed' ? 'Extraction failed. Retry with a valid, unencrypted PDF or UTF-8 text file.' : selected.status === 'completed' && !selected.extracted_text?.trim() ? 'No text found. Scanned PDF OCR is not supported. For receipt OCR, upload a JPEG/PNG through the return desk.' : 'Counts include PDF/text extraction only. No AI summarization is performed.';
  if (['image/jpeg', 'image/png'].includes(selected.mime_type)) {
    $('text-heading').textContent = 'Receipt image original';
    $('text').textContent = 'Use Download original to inspect this image. Receipt OCR and confirmed purchase details are handled in the return desk above.';
    $('processing-help').textContent = 'Server extraction supports PDF/text. JPEG/PNG receipt OCR runs in your browser through the return desk.';
  }
  document.querySelectorAll('.doc').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === selected.id)));
  updateControls();
  if (selected.status === 'processing') schedulePoll(id);
}
function schedulePoll(id) {
  clearTimeout(pollTimer); const current = generation;
  pollTimer = setTimeout(() => {
    if (current !== generation || selected?.id !== id) return;
    if (busy) { schedulePoll(id); return; }
    action('Checking extraction status…', async () => { await select(id); await list(); notice(selected.status === 'processing' ? 'Extraction is still running…' : 'Document status updated.'); });
  }, 5000);
}
$('auth-toggle').onclick = () => {
  registration = !registration; $('name-label').hidden = !registration; $('name').disabled = !registration; $('name').required = registration;
  $('password').minLength = registration ? 8 : 1; $('password').autocomplete = registration ? 'new-password' : 'current-password';
  $('auth-title').textContent = $('auth-submit').textContent = registration ? 'Create account' : 'Sign in';
  $('auth-toggle').textContent = registration ? 'Already registered? Sign in' : 'New here? Create an account';
  $('password-help').textContent = registration ? 'Use at least 8 characters, up to 72 UTF-8 bytes.' : 'Your session lasts up to one hour. Refreshing signs you out.'; notice();
};
$('auth-form').onsubmit = event => {
  event.preventDefault(); action(registration ? 'Creating account…' : 'Signing in…', async () => {
    await window.ManagedAuth.ready;
    if (window.ManagedAuth.enabled) { await window.ManagedAuth.submit(registration); return; }
    const email = $('email').value.trim(), password = $('password').value;
    if (new TextEncoder().encode(password).length > 72) throw new Error('Password must be at most 72 UTF-8 bytes.');
    if (registration) { await request('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('name').value.trim(), email, password }) }); notice('Account created. Signing in…'); }
    const body = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    await completeSignIn(body);
  });
};
async function completeSignIn(body) {
    token = body.token; offset = 0; $('auth-form').reset();
    $('auth').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; $('greeting').textContent = `WELCOME, ${body.user.name}`;
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expiryTimer = setTimeout(() => signOut('Your session expired. Sign in again.'), Math.max(0, payload.exp * 1000 - Date.now()));
    await list(); await window.ReceiptTracker?.onLogin(); notice('Signed in. Your return desk is ready.');
}
$('logout').onclick = () => signOut();
$('upload-form').onsubmit = event => { event.preventDefault(); action('Uploading document…', async () => {
  const file = $('file').files[0]; if (!file) throw new Error('Choose a file first.');
  if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds the 5 MiB limit.');
  if (!/\.(pdf|txt)$/i.test(file.name)) throw new Error('Choose a PDF or .txt file.');
  const data = new FormData(); data.append('document', new Blob([file], { type: /\.pdf$/i.test(file.name) ? 'application/pdf' : 'text/plain' }), file.name);
  const body = await request('/documents/upload', { method: 'POST', body: data }); offset = 0; $('upload-form').reset(); await select(body.document.id); await list(); notice('Uploaded. Select Extract text when you are ready.');
}); };
$('process').onclick = () => action('Extracting text… Keep this page open. No percentage estimate is available.', async () => {
  const id = selected.id; clearSearch('Results cleared because document contents may change. Search again after extraction.');
  try { const processed = await request(`/documents/${encodeURIComponent(id)}/process`, { method: 'POST' }); await select(id); await list(); notice(processed.message || 'Extraction complete. Results saved.'); }
  catch (error) { if (token) { try { await select(id); await list(); } catch {} } throw error; }
});
$('download').onclick = () => action('Preparing download…', async () => {
  const doc = selected, blob = await request(`/documents/${encodeURIComponent(doc.id)}/download`, {}, true);
  if (!token) return; const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = doc.original_name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Original downloaded.');
});
$('refresh').onclick = () => action('Refreshing…', async () => { await list(); if (selected) await select(selected.id); notice('Documents refreshed.'); });
for (const [id, delta] of [['previous', -limit], ['next', limit]]) $(id).onclick = () => action('Loading documents…', async () => { offset = Math.max(0, Math.min(10000, offset + delta)); await list(); notice(); });

function clearSearch(message = 'Process a document to make its text searchable.') {
  searchQuery = ''; searchOffset = 0; searchHasMore = false;
  $('search-form').reset(); $('search-results').replaceChildren();
  $('search-status').textContent = message; $('search-pagination').hidden = true;
}
async function runSearch() {
  $('search-status').textContent = 'Searching your documents...';
  $('search-results').replaceChildren(); $('search-pagination').hidden = true;
  let body;
  try { body = await request(`/search?q=${encodeURIComponent(searchQuery)}&limit=${limit}&offset=${searchOffset}`); }
  catch (error) { $('search-status').textContent = 'Search did not complete. Check the message above and try again.'; throw error; }
  searchHasMore = body.pagination.hasMore;
  $('search-status').textContent = body.results.length ? `${body.results.length} search match${body.results.length === 1 ? '' : 'es'} on this page. Select a match to inspect its source. Counts in details are for the whole document.` : 'No matches. Try different words, or extract your documents first. Common words alone may return no matches.';
  for (const hit of body.results) {
    const button = document.createElement('button'); button.className = 'search-hit';
    const name = document.createElement('strong'); name.textContent = hit.document_name;
    const source = document.createElement('small'); source.textContent = hit.page_number === null ? 'Text file - Search match' : `PDF page ${hit.page_number} - Search match`;
    const excerpt = document.createElement('p'); excerpt.textContent = hit.excerpt;
    button.append(name, source, excerpt);
    button.onclick = () => action('Opening source...', async () => {
      await select(hit.document_id, hit.unit_index);
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('text').focus({ preventScroll: true });
      notice('Source text opened. Download the original to verify it in your PDF viewer.');
    });
    $('search-results').append(button);
  }
  $('search-page').textContent = `Page ${searchOffset / limit + 1}`;
  $('search-pagination').hidden = searchOffset === 0 && !searchHasMore;
  updateControls();
}
$('search-form').onsubmit = event => {
  event.preventDefault(); action('Searching...', async () => {
    searchQuery = $('search-query').value.trim(); searchOffset = 0;
    if (!searchQuery || searchQuery.length > 200) { clearSearch('Enter 1-200 characters to search.'); throw new Error('Enter 1-200 characters to search.'); }
    await runSearch(); notice();
  });
};
$('search-clear').onclick = () => { clearSearch(); notice(); updateControls(); };
for (const [id, delta] of [['search-previous', -limit], ['search-next', limit]]) $(id).onclick = () => action('Searching...', async () => {
  searchOffset = Math.max(0, Math.min(1000, searchOffset + delta)); await runSearch(); notice();
});
$('all-text').onclick = () => action('Loading full document...', async () => { await select(selected.id); notice(); });
