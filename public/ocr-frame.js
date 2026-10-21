'use strict';
// No credentials or network receipt uploads in this frame. Its dedicated worker
// is destroyed with the frame, even when createWorker has not resolved yet.
let started = false;
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'recognize' || started) return;
  started = true;
  let worker;
  const send = data => parent.postMessage(data, location.origin);
  try {
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: '/app/ocr/worker.min.js', corePath: '/app/ocr', langPath: '/app/ocr',
      workerBlobURL: false, cacheMethod: 'none',
      logger: message => send({ type: 'progress', status: message.status, progress: message.progress }),
      errorHandler: () => send({ type: 'failed' }),
    });
    const result = await worker.recognize(new Blob([event.data.bytes], { type: event.data.mime }));
    send({ type: 'recognized', text: result.data.text });
  } catch { send({ type: 'failed' }); }
  finally { if (worker) await worker.terminate().catch(() => {}); }
});
parent.postMessage({ type: 'ready' }, location.origin);
