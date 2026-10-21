'use strict';
(() => {
  const U = window.ReceiptUtils;
  let purchases = [], pageOffset = 0, hasMore = false, draft = null, previewUrl = '', cancelOcr = null, pendingSample = false;
  const pageSize = 50;
  function clearPreview() {
    $('receipt-preview').hidden = true; $('receipt-preview').removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = '';
  }
  function preview(blob) {
    clearPreview(); previewUrl = URL.createObjectURL(blob); $('receipt-preview').src = previewUrl; $('receipt-preview').hidden = false;
    $('receipt-preview-help').textContent = 'Your private original. Use Download original to inspect it at full size.';
  }
  function reset() {
    cancelOcr?.(); clearPreview(); draft = null; purchases = []; pageOffset = 0; hasMore = false;
    $('purchase-editor').hidden = true; $('purchase-form').reset(); $('receipt-upload-form').reset();
    $('purchase-list').replaceChildren(); $('raw-ocr').textContent = ''; $('ocr-suggestions').textContent = '';
    $('sample-intro').hidden = false; $('purchase-fields').disabled = false; $('ocr-progress').hidden = true;
    $('policy-document').replaceChildren(new Option('No attachment', ''));
    $('receipt-retained').textContent = ''; $('review-warnings').textContent = '';
    $('receipt-date-choices').replaceChildren(); $('receipt-date-choices').hidden = true;
    for (const id of ['count-open', 'count-soon', 'count-returned']) $(id).textContent = '0';
  }
  function sync() {
    $('purchase-currency').required = $('purchase-amount').value.trim() !== '';
    $('purchase-amount').required = $('purchase-currency').value !== '';
    $('purchase-previous').disabled = busy || pageOffset === 0;
    $('purchase-next').disabled = busy || !hasMore || pageOffset >= 10000;
    $('receipt-download').hidden = !draft?.receiptId;
    $('receipt-unlink').hidden = !draft?.receiptId;
    $('policy-download').hidden = !$('policy-document').value;
    $('purchase-calendar').hidden = !draft?.id || !draft?.deadlineDate;
    $('purchase-calendar').disabled = busy;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className; return node;
  }
  function render() {
    const day = U.today();
    const annotated = purchases.map(p => ({ ...p, state: U.status(p, day) }));
    $('count-open').textContent = annotated.filter(p => !p.returned).length;
    $('count-soon').textContent = annotated.filter(p => !p.returned && p.state.days !== null && p.state.days >= 0 && p.state.days <= 7).length;
    $('count-returned').textContent = annotated.filter(p => p.returned).length;
    const filter = $('purchase-filter').value;
    const shown = annotated.filter(p => filter === 'all' || (filter === 'active' ? !p.returned : filter === 'due_soon' ? !p.returned && p.state.days !== null && p.state.days >= 0 && p.state.days <= 7 : p.state.key === filter));
    const sort = $('purchase-sort').value;
    shown.sort((a, b) => sort === 'merchant' ? a.merchant.localeCompare(b.merchant) : sort === 'newest' ? b.created_at.localeCompare(a.created_at) : (a.deadline_date ?? '9999-99-99').localeCompare(b.deadline_date ?? '9999-99-99') || a.id.localeCompare(b.id));
    $('purchase-list').replaceChildren();
    if (!shown.length) {
      const empty = element('section', '', 'card purchase-empty');
      empty.append(element('span', '↩', 'empty-mark'), element('h3', purchases.length ? 'Nothing in this view' : pageOffset ? 'No more purchases' : 'A fresh start for your receipts'),
        element('p', purchases.length ? 'Change the status filter to see other purchases on this page.' : 'Upload a receipt or try the synthetic sample. Review the details, confirm a deadline, and it will appear here.'));
      $('purchase-list').append(empty);
    }
    for (const p of shown) {
      const card = element('article', '', 'card purchase-card'); card.dataset.id = p.id;
      const head = element('div', '', 'purchase-card-head'); head.append(element('span', p.state.label, `badge state-${p.state.key}`), element('span', p.amount_minor === null ? 'Total not entered' : `${p.currency} ${U.decimal(p.amount_minor, p.currency)}`, 'purchase-money'));
      card.append(head, element('h3', p.merchant), element('p', p.description || 'Purchase', 'muted'), element('p', `Purchased ${p.purchase_date || '—'}`, 'purchase-date'));
      const remaining = p.returned ? 'Marked returned' : p.state.days === null ? 'Set a deadline when you know it' : p.state.days < 0 ? `${Math.abs(p.state.days)} day${Math.abs(p.state.days) === 1 ? '' : 's'} past deadline` : p.state.days === 0 ? 'Today is the date' : `${p.state.days} day${p.state.days === 1 ? '' : 's'} remaining`;
      const date = element('div', '', 'purchase-deadline'); date.append(element('strong', remaining), element('small', p.deadline_date ? `User-confirmed · ${p.deadline_date}` : 'No store policy inferred')); card.append(date);
      const buttons = element('div', '', 'actions');
      const edit = element('button', 'Review / edit'); edit.onclick = () => action('Opening purchase…', () => openPurchase(p.id)); buttons.append(edit);
      if (p.deadline_date) { const cal = element('button', 'Add to calendar'); cal.onclick = () => action('Preparing calendar…', () => calendar(p.id)); buttons.append(cal); }
      card.append(buttons); $('purchase-list').append(card);
    }
    $('purchase-list-status').textContent = `${shown.length} purchase${shown.length === 1 ? '' : 's'} shown on this page.`;
    $('purchase-page').textContent = `Page ${pageOffset / pageSize + 1}`; sync();
  }
  async function loadPurchases() {
    $('purchase-list-status').textContent = 'Loading your purchases…';
    try {
      const body = await request(`/purchases?limit=${pageSize}&offset=${pageOffset}`);
      purchases = body.purchases; hasMore = purchases.length === pageSize; render();
    } catch (error) { $('purchase-list-status').textContent = 'Purchases could not be refreshed. Try Refresh purchases.'; throw error; }
  }
  async function policyOptions(selectedId = null) {
    const { documents } = await request('/documents?limit=100&offset=0');
    $('policy-document').replaceChildren(new Option('No attachment', ''));
    for (const doc of documents) $('policy-document').add(new Option(doc.original_name, doc.id));
    if (selectedId && !documents.some(d => d.id === selectedId)) $('policy-document').add(new Option('Attached policy document', selectedId));
    $('policy-document').value = selectedId || '';
    $('policy-help').textContent = 'Choose from your 100 most recent private documents, or attach a file. Policy interpretation is manual.';
  }
  function reviewText() {
    $('raw-ocr').textContent = draft?.ocr || 'No OCR text. Manual entry is available.';
    $('ocr-suggestions').textContent = JSON.stringify(draft?.suggestions || {}, null, 2);
    $('review-warnings').textContent = draft?.suggestions?.warnings?.join(' ') || 'Review the details against the original. You control every field.';
    const choices = U.receiptDateReview(draft?.ocr || '').candidates;
    $('receipt-date-choices').replaceChildren(); $('receipt-date-choices').hidden = !choices.length;
    for (const date of choices) {
      const readable = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
      const button = element('button', `${readable} (${date})`); button.type = 'button'; button.dataset.date = date;
      button.onclick = () => { $('purchase-date').value = date; updateDeadline(); $('purchase-date').focus(); };
      $('receipt-date-choices').append(button);
    }
  }
  function updateDeadline(resetConfirmation = true) {
    if (resetConfirmation) $('deadline-confirm').checked = false;
    const source = $('deadline-source').value;
    $('window-fields').hidden = source !== 'window'; $('deadline-date-label').hidden = source === 'none';
    $('deadline-confirm-label').hidden = source === 'none'; $('deadline-confirm').required = source !== 'none';
    $('deadline-date').required = source !== 'none'; $('return-days').required = source === 'window';
    $('deadline-date').readOnly = source === 'window'; $('deadline-override').hidden = source !== 'window';
    $('deadline-calculation').textContent = source === 'none' ? 'No deadline will be established.' : source === 'manual' ? 'You confirm this last-return date from a policy you have checked.' : '';
    if (source === 'window') {
      const days = Number($('return-days').value), counts = $('purchase-day-counts').value === 'true';
      try {
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Enter a return window of 1–3650 days.');
        const date = U.addDays($('purchase-date').value, days - (counts ? 1 : 0));
        $('deadline-date').value = date;
        $('deadline-calculation').textContent = `${$('purchase-date').value} + ${days} days${counts ? ' − 1 day (purchase day counts)' : ' (purchase day does not count)'} = ${date}. Check the policy before confirming.`;
      } catch (error) { $('deadline-date').value = ''; $('deadline-calculation').textContent = error.message; }
    }
  }
  async function newDraft() {
    cancelOcr?.(); clearPreview(); $('purchase-form').reset();
    draft = { id: null, receiptId: null, policyId: null, ocr: '', suggestions: {}, deadlineDate: null };
    $('editor-title').textContent = 'Review your purchase'; $('purchase-save').textContent = 'Save purchase';
    $('purchase-editor').hidden = false; $('receipt-preview-help').textContent = 'You can save a purchase without a receipt.';
    $('receipt-retained').textContent = ''; $('purchase-fields').disabled = false;
    reviewText(); updateDeadline(); await policyOptions(); sync();
    $('editor-title').focus(); $('purchase-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function openPurchase(id) {
    const { purchase: p } = await request(`/purchases/${encodeURIComponent(id)}`);
    await newDraft();
    draft = { id: p.id, revision: p.revision, receiptId: p.receipt_document_id, policyId: p.policy_document_id, ocr: p.raw_ocr_text, suggestions: p.suggestions, deadlineDate: p.deadline_date };
    $('editor-title').textContent = 'Purchase details'; $('purchase-save').textContent = 'Save changes';
    $('purchase-merchant').value = p.merchant; $('purchase-date').value = p.purchase_date || '';
    $('purchase-description').value = p.description; $('purchase-amount').value = p.amount_minor === null ? '' : U.decimal(p.amount_minor, p.currency);
    $('purchase-currency').value = p.currency || ''; $('policy-notes').value = p.policy_notes; $('purchase-returned').checked = p.returned;
    $('deadline-source').value = p.deadline_source; $('return-days').value = p.return_window_days ?? '';
    $('purchase-day-counts').value = String(p.purchase_day_counts ?? false); $('deadline-date').value = p.deadline_date || '';
    reviewText(); updateDeadline(); await policyOptions(p.policy_document_id);
    $('receipt-retained').textContent = p.deadline_date ? `Saved deadline: ${p.deadline_date} · User-confirmed. Reconfirm before saving any edits.` : 'No deadline established.';
    if (p.receipt_document_id) {
      const { document: doc } = await request(`/documents/${p.receipt_document_id}`);
      $('receipt-preview-help').textContent = doc.original_name;
      if (['image/jpeg', 'image/png'].includes(doc.mime_type)) {
        try { preview(await request(`/documents/${doc.id}/download`, {}, true)); }
        catch { $('receipt-preview-help').textContent = 'Preview unavailable. Try Download original.'; }
      }
    }
    sync(); notice('Purchase opened. Reconfirm any deadline before saving changes.');
  }
  async function uploadDocument(file) {
    if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds the 5 MiB limit.');
    const data = new FormData(); data.append('document', file, file.name);
    const { document: doc } = await request('/documents/upload', { method: 'POST', body: data }); return doc;
  }
  async function recognize(file) {
    const current = generation;
    const bytes = await file.arrayBuffer();
    if (generation !== current) return null;
    $('ocr-progress').hidden = false; $('ocr-meter').removeAttribute('value'); $('ocr-status').textContent = 'Loading private browser OCR assets…';
    $('purchase-fields').disabled = true;
    return new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'Receipt text recognition';
      let finished = false;
      function cleanup(result) {
        if (finished) return; finished = true; clearTimeout(timer); window.removeEventListener('message', receive);
        frame.remove(); cancelOcr = null; $('ocr-progress').hidden = true; $('purchase-fields').disabled = false; resolve(result);
      }
      async function receive(event) {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || current !== generation) return;
        if (event.data?.type === 'ready') frame.contentWindow.postMessage({ type: 'recognize', bytes, mime: file.type }, location.origin, [bytes]);
        else if (event.data?.type === 'progress') {
          const value = event.data.progress;
          $('ocr-status').textContent = `${event.data.status || 'Reading receipt'}${Number.isFinite(value) ? ` · ${Math.round(value * 100)}%` : ''}`;
          if (Number.isFinite(value)) $('ocr-meter').value = value; else $('ocr-meter').removeAttribute('value');
        } else if (event.data?.type === 'recognized') cleanup(typeof event.data.text === 'string' ? event.data.text : '');
        else if (event.data?.type === 'failed') cleanup(null);
      }
      const timer = setTimeout(() => cleanup(null), 120000);
      cancelOcr = () => cleanup(null); frame.src = '/app/ocr-frame.html'; window.addEventListener('message', receive); document.body.append(frame);
    });
  }
  async function uploadReceipt(file) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Receipt OCR supports JPEG and PNG images. Use the document library for PDF/text.');
    const current = generation;
    const doc = await uploadDocument(file); // Server validates bytes/dimensions before preview or OCR.
    if (current !== generation) return;
    await newDraft(); draft.receiptId = doc.id; preview(file); sync();
    $('receipt-retained').textContent = 'Original saved privately. If you close or a save fails, it remains in your document library. You can retry this form without uploading again.';
    const text = await recognize(file);
    if (current !== generation || !draft) return;
    if (text === null || !text.trim()) {
      draft.ocr = text || ''; draft.suggestions = { warnings: ['OCR failed, was cancelled, timed out, or found no text. Your original is safe. Enter the details manually.'] };
      reviewText(); notice('The receipt is saved. Enter purchase details manually; OCR is optional.');
    } else {
      draft.ocr = text.slice(0, 30000); draft.suggestions = U.parseReceipt(draft.ocr);
      if (text.length > 30000) draft.suggestions.warnings.push('OCR text was limited to 30,000 characters.');
      $('purchase-merchant').value = draft.suggestions.merchant || ''; $('purchase-date').value = draft.suggestions.purchaseDate || '';
      $('purchase-amount').value = draft.suggestions.amount || ''; $('purchase-currency').value = draft.suggestions.currency || '';
      // Avoid preselecting a currency without an amount: server requires the pair.
      if (!draft.suggestions.amount) $('purchase-currency').value = '';
      reviewText(); notice('Receipt read. Review every suggestion and set your own deadline.');
    }
    $('receipt-upload-form').reset(); await list(); $('purchase-merchant').focus();
  }
  async function sample() {
    const response = await fetch('/app/samples/maple-goods.png', { cache: 'no-store' });
    if (!response.ok) throw new Error('Sample receipt is unavailable. You can upload your own or enter manually.');
    const file = new File([await response.blob()], 'synthetic-maple-goods.png', { type: 'image/png' });
    await uploadReceipt(file);
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function calendar(id) {
    const blob = await request(`/purchases/${id}/calendar`, {}, true); download(blob, `return-deadline-${id}.ics`);
    notice('Calendar event downloaded for the saved deadline. Import it into your calendar; this app has not scheduled a notification.');
  }
  async function original(id) {
    const { document: doc } = await request(`/documents/${id}`);
    download(await request(`/documents/${id}/download`, {}, true), doc.original_name); notice('Private original downloaded.');
  }
  async function savePurchase() {
    if (!draft) throw new Error('Open a purchase first.');
    const currentDraft = draft;
    const source = $('deadline-source').value;
    let deadline = { source };
    if (source !== 'none') {
      if (!$('deadline-confirm').checked) throw new Error('Review the deadline and check the confirmation box.');
      deadline = { source, date: $('deadline-date').value, confirmed: true };
      if (source === 'window') Object.assign(deadline, { days: Number($('return-days').value), purchaseDayCounts: $('purchase-day-counts').value === 'true' });
    }
    const payload = { merchant: $('purchase-merchant').value.trim(), purchaseDate: $('purchase-date').value || null,
      amount: $('purchase-amount').value.trim() || null, currency: $('purchase-currency').value || null,
      description: $('purchase-description').value.trim(), policyNotes: $('policy-notes').value.trim(),
      receiptDocumentId: draft.receiptId, policyDocumentId: $('policy-document').value || null,
      rawOcrText: draft.ocr, suggestions: draft.suggestions, deadline, returned: $('purchase-returned').checked };
    if ((payload.amount === null) !== (payload.currency === null)) throw new Error('Enter both total and currency, or leave both blank.');
    if (payload.purchaseDate && !U.validDate(payload.purchaseDate)) throw new Error('Check the purchase date.');
    const policy = $('policy-file').files[0];
    if (policy) {
      const doc = await uploadDocument(policy); currentDraft.policyId = doc.id;
      $('policy-document').add(new Option(doc.original_name, doc.id)); $('policy-document').value = doc.id; $('policy-file').value = '';
      payload.policyDocumentId = doc.id;
      $('policy-help').textContent = 'Policy original saved privately. Retry saving without reuploading if the purchase save fails.';
    }
    if (currentDraft.id) payload.revision = currentDraft.revision;
    const result = await request(currentDraft.id ? `/purchases/${currentDraft.id}` : '/purchases', { method: currentDraft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const p = result.purchase; currentDraft.id = p.id; currentDraft.revision = p.revision; currentDraft.policyId = p.policy_document_id; currentDraft.deadlineDate = p.deadline_date;
    $('deadline-confirm').checked = false; $('purchase-save').textContent = 'Save changes';
    $('receipt-retained').textContent = p.deadline_date ? `Saved · User-confirmed deadline: ${p.deadline_date}. Reconfirm before saving edits.` : 'Purchase saved without a deadline.';
    try { await loadPurchases(); await list(); } catch { notice('Purchase saved, but the lists could not refresh. Use Refresh purchases.', true); sync(); return; }
    sync(); notice('Purchase saved. Your receipt and confirmed details are private to your account.');
  }
  window.ReceiptTracker = { reset, sync, async onLogin() {
    $('sample-intro').hidden = true; pageOffset = 0; await loadPurchases();
    if (pendingSample) { pendingSample = false; await sample(); }
  } };
  $('sample-start').onclick = () => { pendingSample = true; notice('Sign in or create an account to save the synthetic sample privately.'); $('email').focus(); };
  $('sample-receipt').onclick = () => action('Loading synthetic sample receipt…', sample);
  $('manual-purchase').onclick = () => action('Opening manual entry…', async () => { await newDraft(); notice('Enter the details you know. A receipt and OCR are optional.'); });
  $('receipt-upload-form').onsubmit = event => { event.preventDefault(); action('Saving your private receipt…', async () => {
    const file = $('receipt-file').files[0]; if (!file) throw new Error('Choose a receipt image first.'); await uploadReceipt(file);
  }); };
  $('ocr-cancel').onclick = () => cancelOcr?.();
  $('editor-close').onclick = () => { cancelOcr?.(); clearPreview(); draft = null; $('purchase-editor').hidden = true; $('purchase-form').reset(); $('manual-purchase').focus(); notice('Editor closed. Uploaded originals remain in your private document library.'); };
  $('receipt-unlink').onclick = () => { if (draft) draft.receiptId = null; clearPreview(); $('receipt-preview-help').textContent = 'Receipt unlinked in this form. Save to apply; the original remains in your document library.'; sync(); };
  $('purchase-form').onsubmit = event => { event.preventDefault(); action('Saving reviewed purchase…', async () => {
    $('purchase-fields').disabled = true;
    try { await savePurchase(); } finally { $('purchase-fields').disabled = false; }
  }); };
  for (const id of ['deadline-source', 'purchase-date', 'return-days', 'purchase-day-counts']) $(id).addEventListener('input', () => updateDeadline());
  $('deadline-date').addEventListener('input', () => { $('deadline-confirm').checked = false; });
  $('deadline-override').onclick = () => { $('deadline-source').value = 'manual'; updateDeadline(); $('deadline-date').focus(); };
  $('purchase-calendar').onclick = () => action('Exporting saved deadline…', () => calendar(draft.id));
  $('receipt-download').onclick = () => action('Downloading private receipt…', () => original(draft.receiptId));
  $('policy-download').onclick = () => action('Downloading private policy…', () => original($('policy-document').value));
  $('policy-document').onchange = sync;
  $('purchase-amount').addEventListener('input', sync);
  $('purchase-currency').addEventListener('change', sync);
  $('purchase-refresh').onclick = () => action('Refreshing purchases…', async () => { await loadPurchases(); notice('Purchases refreshed.'); });
  $('purchase-filter').onchange = render; $('purchase-sort').onchange = render;
  for (const [id, delta] of [['purchase-previous', -pageSize], ['purchase-next', pageSize]]) $(id).onclick = () => action('Loading purchases…', async () => { pageOffset = Math.max(0, Math.min(10000, pageOffset + delta)); await loadPurchases(); notice(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) render(); });
  setInterval(() => { if (token && !document.hidden) render(); }, 60000);
  window.addEventListener('pagehide', () => { cancelOcr?.(); clearPreview(); });
  sync();
})();
