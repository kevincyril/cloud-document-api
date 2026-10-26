'use strict';
(() => {
  const $ = id => document.getElementById(id), U = window.ReceiptUtils;
  let serial = 0, cancel, imageUrl = '';
  let purchases = [], documents = [], draft = null, baseline = '', reading = false, saving = false;
  const fields = ['guest-merchant','guest-description','guest-date','guest-amount','guest-currency','guest-days','guest-counts','guest-explicit','guest-notes','guest-returned','guest-confirm'];
  const snapshot = () => JSON.stringify(fields.map(id => $(id).type === 'checkbox' ? $(id).checked : $(id).value).concat(Array.from($('guest-policy').files).map(f => f.name + f.size + f.lastModified)));
  const dirty = () => Boolean(draft && snapshot() !== baseline);
  const discard = () => !dirty() || confirm('Discard unsaved demo edits? Saved demo purchases stay in this tab.');
  function status(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); if(error)$('notice').scrollIntoView({behavior:'smooth',block:'center'}); }
  function working(value) {
    reading = value;
    for (const id of ['guest-read', 'guest-sample', 'guest-file','guest-save','guest-manual','guest-examples']) $(id).disabled = value;
    $('guest-cancel').hidden = !value;
  }
  function clear() {
    serial++; cancel?.(); cancel = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = '';
    $('guest-image').removeAttribute('src'); $('guest-results').hidden = true;
    $('guest-upload').reset();
    $('guest-purchase').reset(); draft = null; baseline = '';
    for (const id of ['guest-merchant', 'guest-date', 'guest-amount', 'guest-currency', 'guest-days']) $(id).value = '';
    $('guest-counts').value = 'false';
    for (const id of ['guest-ocr', 'guest-suggestions', 'guest-warnings']) $(id).textContent = '';
    working(false); deadline(); status('Current preview cleared. Saved demo purchases remain in this tab.');
  }
  function deadline() {
    try {
      if ($('guest-explicit').value) { $('guest-deadline').textContent = `Preview deadline: ${deadlineDate()}. Check the store policy before relying on it.`; return; }
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
    draft = { file, ocr: text, suggestions: parsed };
    imageUrl = URL.createObjectURL(file); $('guest-image').src = imageUrl;
    $('guest-image').hidden = false;
    $('guest-merchant').value = parsed.merchant || ''; $('guest-date').value = parsed.purchaseDate || '';
    $('guest-amount').value = parsed.amount || ''; $('guest-currency').value = parsed.currency || '';
    $('guest-ocr').textContent = text; $('guest-suggestions').textContent = JSON.stringify(parsed, null, 2);
    $('guest-warnings').textContent = (parsed.warnings || []).join(' ') || 'Review every suggestion against the original receipt.';
    $('guest-results').hidden = false; deadline();
    baseline = snapshot(); draftStatus();
    status('Receipt read. Review and edit the suggestions below. This preview is not saved.');
    $('guest-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function start(sample) {
    if (!discard()) return;
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
  $('guest-sample').onclick = () => start(true); $('guest-clear').onclick = () => { if (discard()) clear(); };
  $('guest-cancel').onclick = () => { clear(); status('Reading cancelled. Nothing was saved.'); };
  for (const id of ['guest-date', 'guest-days', 'guest-counts','guest-explicit']) $(id).addEventListener('input', () => { $('guest-confirm').checked = false; deadline(); });
  function draftStatus() { $('guest-draft-status').textContent = !draft ? '' : dirty() ? 'Unsaved demo edits' : draft.id ? 'Saved in this tab only' : 'Review before saving to the demo'; }
  $('guest-purchase').addEventListener('input', draftStatus);
  function deadlineDate() {
    const explicit = $('guest-explicit').value;
    if (explicit) { if (!U.validDate(explicit)) throw new Error('Enter a valid last-return date.'); return explicit; }
    if (!$('guest-days').value) return null;
    const days = Number($('guest-days').value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Enter a return window of 1–3650 days.');
    return U.addDays($('guest-date').value, days - ($('guest-counts').value === 'true' ? 1 : 0));
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function calendar(p) {
    if (!p?.deadline_date) { status('Set a confirmed deadline and save the demo purchase first.', true); return; }
    const date = p.deadline_date.replaceAll('-',''), next = U.addDays(p.deadline_date,1).replaceAll('-','');
    const escape = text => text.replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll(',','\\,').replaceAll(';','\\;').replaceAll('\r','');
    download(new Blob([['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Return Keeper//Guest Demo//EN','BEGIN:VEVENT',`UID:${p.id}@return-keeper-demo`,`DTSTAMP:${new Date().toISOString().replaceAll(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}`,`DTSTART;VALUE=DATE:${date}`,`DTEND;VALUE=DATE:${next}`,`SUMMARY:${escape('Return deadline: '+p.merchant)}`,'DESCRIPTION:User-confirmed demo deadline. Check the store policy.','END:VEVENT','END:VCALENDAR',''].join('\r\n')],{type:'text/calendar;charset=utf-8'}),'return-deadline.ics');
  }
  function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, work) { const b = node('button',text); b.type='button'; b.onclick=work; return b; }
  function matching() {
    const q=$('guest-query').value.trim().toLowerCase(), filter=$('guest-filter').value;
    return purchases.filter(p => {
      const state=U.status(p);
      return [p.merchant,p.description,p.policy_notes].join(' ').toLowerCase().includes(q) && (filter==='all' || filter==='active'&&!p.returned || filter==='due_soon'&&!p.returned&&state.days!==null&&state.days>=0&&state.days<=7 || filter==='returned'&&p.returned || filter==='deadline_passed'&&state.key===filter || filter==='no_deadline'&&!p.returned&&!p.deadline_date);
    }).sort((a,b)=> $('guest-sort').value==='merchant' ? a.merchant.localeCompare(b.merchant) : $('guest-sort').value==='newest' ? b.created_at.localeCompare(a.created_at) : (a.deadline_date||'9999').localeCompare(b.deadline_date||'9999'));
  }
  function library() {
    const q=$('guest-document-query').value.trim().toLowerCase(); $('guest-documents').replaceChildren();
    for (const doc of documents.filter(d=>(d.file.name+' '+d.text).toLowerCase().includes(q))) {
      const entry=node('div','', 'doc'); entry.append(node('strong',doc.file.name),node('p',doc.text ? doc.text.slice(0,350) : 'Original attachment; no extracted text.','muted'),button('Download original',()=>download(doc.file,doc.file.name))); $('guest-documents').append(entry);
    }
    if (!$('guest-documents').children.length) $('guest-documents').append(node('p','No matching demo documents. Save a receipt to add its original.'));
  }
  function render() {
    const active=purchases.filter(p=>!p.returned); $('guest-active').textContent=active.length; $('guest-return-count').textContent=purchases.length-active.length;
    $('guest-soon').textContent=active.filter(p=>{const s=U.status(p);return s.days!==null&&s.days>=0&&s.days<=7;}).length;
    const shown=matching(); $('guest-list-status').textContent=`${shown.length} matching demo purchases · ${purchases.length} total · stored in this tab only`;
    $('guest-export').disabled=!shown.length; $('guest-list').replaceChildren();
    for (const p of shown) {
      const s=U.status(p), card=node('article','', 'card purchase-card'); card.dataset.id=p.id;
      card.append(node('span',s.label,`badge state-${s.key}`),node('h3',p.merchant),node('p',p.description),node('p',p.amount_minor===null ? 'Total not entered' : `${p.currency} ${U.decimal(p.amount_minor,p.currency)}`),node('p',`Purchased ${p.purchase_date||'—'} · Deadline ${p.deadline_date||'not set'}`));
      const actions=node('div','','actions');
      actions.append(button('Review / edit',()=>open(p)),button(p.returned?'Mark active':'Mark returned',()=>{
        if (draft?.id===p.id && dirty()) { status('Save or clear your unsaved edits first.',true); return; }
        p.returned=!p.returned; if(draft?.id===p.id){$('guest-returned').checked=p.returned;baseline=snapshot();draftStatus();} render();
      }),button('Delete purchase',()=>{
        if(!confirm(`Delete demo purchase “${p.merchant}”? Originals stay in the demo library.`))return;
        purchases=purchases.filter(item=>item.id!==p.id);if(draft?.id===p.id)clear();render();status('Demo purchase deleted. Originals remain in the demo library.');
      }));
      if(p.deadline_date)actions.append(button('Add to calendar',()=>calendar(p)));
      card.append(actions);$('guest-list').append(card);
    }
    if(!shown.length)$('guest-list').append(node('p','No matching purchases. Read a receipt, enter details manually, or load the demo dashboard.','purchase-empty'));
    library();
  }
  function open(p) {
    if(!discard())return;clear();draft={...p};
    const values={'guest-merchant':p.merchant,'guest-description':p.description,'guest-date':p.purchase_date,'guest-amount':p.amount_minor===null?'':U.decimal(p.amount_minor,p.currency),'guest-currency':p.currency,'guest-days':p.return_window_days,'guest-counts':String(p.purchase_day_counts||false),'guest-explicit':p.return_window_days?'':p.deadline_date,'guest-notes':p.policy_notes};
    for(const [id,value]of Object.entries(values))$(id).value=value??'';
    $('guest-returned').checked=p.returned;$('guest-confirm').checked=Boolean(p.deadline_date);
    $('guest-ocr').textContent=p.ocr||'';$('guest-suggestions').textContent=JSON.stringify(p.suggestions||{},null,2);
    $('guest-warnings').textContent='Review demo details against the original. Changes stay in this tab.';
    $('guest-image').hidden=!p.file;if(p.file){imageUrl=URL.createObjectURL(p.file);$('guest-image').src=imageUrl;}
    $('guest-results').hidden=false;baseline=snapshot();draftStatus();deadline();$('guest-results').scrollIntoView({behavior:'smooth'});
  }
  $('guest-manual').onclick=()=>{if(!discard())return;clear();draft={};$('guest-image').hidden=true;$('guest-results').hidden=false;baseline=snapshot();draftStatus();$('guest-merchant').focus();};
  $('guest-purchase').onsubmit=async event=>{
    event.preventDefault();if(reading||saving||!draft)return;
    saving=true;$('guest-save').disabled=true;
    try{
      const date=$('guest-date').value, currency=$('guest-currency').value, amount=$('guest-amount').value.trim(), merchant=$('guest-merchant').value.trim();
      if(!merchant)throw new Error('Enter a merchant.');if(date&&!U.validDate(date))throw new Error('Enter a valid purchase date.');
      let minor=null;
      if(amount||currency){const precision=currency==='JPY'?0:currency==='KWD'?3:2;const match=amount.match(/^(\d+)(?:\.(\d+))?$/);if(!currency||!match||(match[2]||'').length>precision)throw new Error('Enter a valid nonnegative total and currency, using its decimal precision.');minor=(BigInt(match[1])*10n**BigInt(precision)+BigInt((match[2]||'').padEnd(precision,'0')||'0')).toString();if(minor.length>15)throw new Error('Total is too large.');}
      const due=deadlineDate();if(due&&!$('guest-confirm').checked)throw new Error('Confirm the deadline after checking the policy.');
      const policy=$('guest-policy').files[0];if(policy&&(policy.size>5*1024*1024||! /\.(pdf|txt|png|jpe?g)$/i.test(policy.name)))throw new Error('Policy must be a PDF, text, or receipt image of up to 5 MiB.');
      const original=draft, current=serial, submitted=snapshot();
      const policyText=policy&&/\.txt$/i.test(policy.name)?(await policy.text()).slice(0,30000):'';
      if(current!==serial)return;
      if(submitted!==snapshot())throw new Error('Details changed while reading the attachment. Review and save again.');
      const p={...original,id:original.id||crypto.randomUUID(),merchant,description:$('guest-description').value,purchase_date:date||null,amount_minor:minor,currency:currency||null,deadline_date:due,return_window_days:due&&!$('guest-explicit').value?Number($('guest-days').value):null,purchase_day_counts:$('guest-counts').value==='true',policy_notes:$('guest-notes').value,returned:$('guest-returned').checked,created_at:original.created_at||new Date().toISOString()};
      if(p.file&&!documents.some(d=>d.file===p.file))documents.push({file:p.file,text:p.ocr||''});
      if(policy){documents.push({file:policy,text:policyText});p.policyFile=policy;}
      purchases=purchases.filter(item=>item.id!==p.id);purchases.push(p);draft=p;$('guest-policy').value='';baseline=snapshot();draftStatus();render();status('Saved to this demo tab. Refreshing or leaving clears demo data.');
    }catch(error){status(error.message,true);}finally{saving=false;$('guest-save').disabled=reading;}
  };
  $('guest-original').onclick=()=>draft?.file?download(draft.file,draft.file.name):status('This manual purchase has no receipt original.');
  $('guest-editor-calendar').onclick=()=>{if(dirty()){status('Save your edits before downloading the calendar event.',true);return;}calendar(draft);};
  $('guest-export').onclick=()=>download(new Blob([U.purchasesCsv(matching())],{type:'text/csv;charset=utf-8'}),'return-keeper-demo.csv');
  for(const id of ['guest-query','guest-filter','guest-sort'])$(id).addEventListener('input',render);
  $('guest-document-query').oninput=library;
  $('guest-due').onclick=()=>{$('guest-filter').value='due_soon';render();};
  $('guest-examples').onclick=()=>{
    const today=U.today();
    const shifted=days=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
    for(const [i,name,delta,returned]of [[0,'Demo Outdoor Store',3,false],[1,'Demo Bookshop',-2,false],[2,'Demo Home Goods',12,true]]){
      const id='synthetic-demo-'+i;if(purchases.some(p=>p.id===id))continue;
      purchases.push({id,merchant:name,description:'Synthetic example — not a real purchase',purchase_date:shifted(-10),amount_minor:String(2499+i*1000),currency:'USD',deadline_date:shifted(delta),returned,policy_notes:'Demo deadline for exploring filters.',created_at:new Date().toISOString()});
    }render();status('Loaded synthetic examples. Try filters, return status, editing, CSV, and calendar downloads.');
  };
  function resetAll(){clear();purchases=[];documents=[];$('guest-query').value='';$('guest-document-query').value='';$('guest-filter').value='all';render();}
  $('guest-reset').onclick=()=>{if(confirm('Clear all demo purchases, documents, and edits in this tab?')){resetAll();status('All demo data cleared.');}};
  window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',resetAll);
  render();
})();
