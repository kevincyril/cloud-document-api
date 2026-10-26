'use strict';
(() => {
  const $ = id => document.getElementById(id), U = window.ReceiptUtils;
  let serial = 0, cancel, imageUrl = '';
  function status(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
  function working(value) {
    for (const id of ['guest-read', 'guest-sample', 'guest-file']) $(id).disabled = value;
    $('guest-cancel').hidden = !value;
  }
  function clear() {
    serial++; cancel?.(); cancel = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = '';
    $('guest-image').removeAttribute('src'); $('guest-results').hidden = true;
    $('guest-upload').reset();
    for (const id of ['guest-merchant', 'guest-date', 'guest-amount', 'guest-currency', 'guest-days']) $(id).value = '';
    $('guest-counts').value = 'false';
    for (const id of ['guest-ocr', 'guest-suggestions', 'guest-warnings']) $(id).textContent = '';
    working(false); deadline(); status('Preview cleared. Nothing was saved.');
  }
  function deadline() {
    try {
      const days = Number($('guest-days').value);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Enter a purchase date and a return window of 1–3650 days.');
      const date = U.addDays($('guest-date').value, days - ($('guest-counts').value === 'true' ? 1 : 0));
      $('guest-deadline').textContent = `Preview deadline: ${date}. Check the store policy before relying on it.`;
    } catch (error) { $('guest-deadline').textContent = error.message; }
  }
  function recognize(bytes, mime, current) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'Guest receipt recognition';
      let done = false, sent = false;
      function finish(error, text) {
        if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); cancel = null;
        error ? reject(error) : resolve(text);
      }
      function receive(event) {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || current !== serial) return;
        if (event.data?.type === 'ready' && !sent) { sent = true; frame.contentWindow.postMessage({ type: 'recognize', bytes, mime }, location.origin, [bytes]); }
        else if (event.data?.type === 'progress') status(event.data.status || 'Reading your receipt…');
        else if (event.data?.type === 'recognized') finish(null, typeof event.data.text === 'string' ? event.data.text.slice(0, 30000) : '');
        else if (event.data?.type === 'failed') finish(new Error('Receipt reading failed. Try a clearer image or the sample.'));
      }
      const timer = setTimeout(() => finish(new Error('Reading timed out. Try a smaller, clearer image.')), 120000);
      cancel = () => finish(new Error('Reading cancelled. Nothing was saved.'));
      frame.src = '/app/ocr-frame.html'; window.addEventListener('message', receive); document.body.append(frame);
    });
  }
  async function read(file, current) {
    if (!['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a JPEG or PNG of up to 5 MiB.');
    const bitmap = await createImageBitmap(file);
    try { if (bitmap.width > 8000 || bitmap.height > 8000 || bitmap.width * bitmap.height > 12000000) throw new Error('Use an image of up to 12 megapixels and 8000 pixels per side.'); }
    finally { bitmap.close(); }
    if (current !== serial) return;
    const bytes = await file.arrayBuffer();
    if (current !== serial) return;
    status('Loading browser OCR. Your image stays on this device…');
    const text = await recognize(bytes, file.type, current);
    if (current !== serial) return;
    const parsed = U.parseReceipt(text);
    imageUrl = URL.createObjectURL(file); $('guest-image').src = imageUrl;
    $('guest-merchant').value = parsed.merchant || ''; $('guest-date').value = parsed.purchaseDate || '';
    $('guest-amount').value = parsed.amount || ''; $('guest-currency').value = parsed.currency || '';
    $('guest-ocr').textContent = text; $('guest-suggestions').textContent = JSON.stringify(parsed, null, 2);
    $('guest-warnings').textContent = (parsed.warnings || []).join(' ') || 'Review every suggestion against the original receipt.';
    $('guest-results').hidden = false; deadline();
    status('Receipt read. Review and edit the suggestions below. This preview is not saved.');
    $('guest-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function start(sample) {
    const file = $('guest-file').files[0]; clear(); const current = serial; working(true);
    try {
      let receipt = file;
      if (sample) {
        status('Loading synthetic sample…');
        const response = await fetch('/app/samples/maple-goods.png', { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) throw new Error('Sample could not load. Try your own receipt.');
        receipt = new File([await response.blob()], 'sample-receipt.png', { type: 'image/png' });
      }
      if (current !== serial) return;
      if (!receipt) throw new Error('Choose a receipt first.');
      await read(receipt, current);
    } catch (error) { if (current === serial) status(error.message || 'Unable to read this receipt.', true); }
    finally { if (current === serial) working(false); }
  }
  $('guest-upload').onsubmit = event => { event.preventDefault(); start(false); };
  $('guest-sample').onclick = () => start(true); $('guest-clear').onclick = clear;
  $('guest-cancel').onclick = () => { clear(); status('Reading cancelled. Nothing was saved.'); };
  for (const id of ['guest-date', 'guest-days', 'guest-counts']) $(id).addEventListener('input', deadline);
  window.addEventListener('pagehide', clear);
})();
