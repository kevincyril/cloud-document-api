'use strict';
// No credentials or network receipt uploads in this frame. Its dedicated worker
// is destroyed with the frame, even when createWorker has not resolved yet.
let started = false;
function focusedPixels(bitmap, rectangle, width, height, red) {
  // Browser-native enlargement differs between engines. Use the same bounded
  // Lanczos resampling for tiny value crops so their glyphs remain consistent.
  const source = document.createElement('canvas'); source.width = rectangle.width; source.height = rectangle.height;
  const context = source.getContext('2d', { willReadFrequently: true });
  context.fillStyle = 'white'; context.fillRect(0, 0, source.width, source.height);
  context.drawImage(bitmap, rectangle.left, rectangle.top, rectangle.width, rectangle.height, 0, 0, source.width, source.height);
  const rgba = context.getImageData(0, 0, source.width, source.height).data;
  const kernel = value => {
    if (Math.abs(value) < 0.000001) return 1;
    if (Math.abs(value) >= 3) return 0;
    return Math.sin(Math.PI * value) * Math.sin(Math.PI * value / 3) / (Math.PI * Math.PI * value * value / 3);
  };
  const weights = (from, to) => Array.from({ length: to }, (_, i) => {
    const point = (i + 0.5) * from / to - 0.5, start = Math.floor(point) - 2;
    const values = Array.from({ length: 6 }, (_, n) => kernel(point - start - n));
    const sum = values.reduce((a,b) => a+b,0);
    return { start, values: values.map(value => value / sum) };
  });
  const xs = weights(source.width, width), ys = weights(source.height, height);
  const horizontal = new Float32Array(width * source.height), output = new Float32Array(width * height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    xs[x].values.forEach((weight, n) => {
      const sx = xs[x].start + n, index = (y * source.width + sx) * 4;
      value += weight * (sx < 0 || sx >= source.width ? 255 : red ? rgba[index] : .2126 * rgba[index] + .7152 * rgba[index+1] + .0722 * rgba[index+2]);
    });
    horizontal[y * width + x] = value;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    ys[y].values.forEach((weight, n) => { const sy = ys[y].start + n; value += weight * (sy < 0 || sy >= source.height ? 255 : horizontal[sy * width + x]); });
    output[y * width + x] = value;
  }
  return output;
}
function detailImage(bitmap, rectangle, requestedScale, options = {}) {
  const scale = Math.min(requestedScale, 2800 / rectangle.width, Math.sqrt(4000000 / (rectangle.width * rectangle.height)));
  const canvas = document.createElement('canvas');
  const padding = options.padding || 0;
  const width = Math.ceil(rectangle.width * scale), height = Math.ceil(rectangle.height * scale);
  canvas.width = width + padding * 2; canvas.height = height + padding * 2;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, rectangle.left, rectangle.top, rectangle.width, rectangle.height, padding, padding, width, height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const focused = requestedScale >= 8 && width * height <= 1000000 ? focusedPixels(bitmap, rectangle, width, height, options.red) : null;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const x = (i / 4) % canvas.width - padding, y = Math.floor(i / 4 / canvas.width) - padding;
    const brightness = focused ? (x < 0 || y < 0 || x >= width || y >= height ? 255 : focused[y * width + x]) : options.red ? pixels.data[i] : 0.2126 * pixels.data[i] + 0.7152 * pixels.data[i + 1] + 0.0722 * pixels.data[i + 2];
    const value = brightness < (options.threshold || 210) ? 0 : 255;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value; pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return { canvas, scale };
}
function wordsIn(read) { return (read.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []).flatMap(line => line.words || []); }
function valueAfter(label, words) {
  return words.filter(word => word.bbox.x0 > label.bbox.x1 && /\d/.test(word.text) && Math.min(word.bbox.y1, label.bbox.y1) > Math.max(word.bbox.y0, label.bbox.y0)).sort((a,b) => a.bbox.x0-b.bbox.x0)[0];
}
function valueRectangle(value, scale, bitmap, offsetTop = 0, round = Math.floor) {
  const left = Math.max(0, round(value.bbox.x0 / scale) - 6);
  const top = Math.max(0, offsetTop + round(value.bbox.y0 / scale) - 4);
  return { left, top, width: Math.min(bitmap.width-left, Math.ceil((value.bbox.x1-value.bbox.x0)/scale)+24), height: Math.min(bitmap.height-top, Math.ceil((value.bbox.y1-value.bbox.y0)/scale)+12) };
}
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
    const blob = new Blob([event.data.bytes], { type: event.data.mime });
    const result = await worker.recognize(blob);
    let text = result.data.text;
    const parsed = ReceiptUtils.parseReceipt(text);
    const missingDate = !parsed.purchaseDate && !ReceiptUtils.receiptDateReview(text).candidates.length;
    // Tiny form text can be lost in a full-page read. Retry only missing fields
    // on small images, with bounded regions, and reuse the existing worker.
    if (missingDate || !parsed.amount) {
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width < 1000 && bitmap.height < 1500) {
          send({ type: 'progress', status: 'Reading small print in the header and totals' });
          await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
          if (missingDate) {
            const header = detailImage(bitmap, { left: 0, top: 0, width: bitmap.width, height: Math.ceil(bitmap.height * 0.30) }, 5);
            const read = await worker.recognize(header.canvas, {}, { text: true, blocks: true });
            text += '\n' + read.data.text;
            const words = wordsIn(read);
            const lines = (read.data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []);
            for (const line of lines.filter(line => /\bdate\b/i.test(line.text) && !/due|ship|deliver|expir|return/i.test(line.text)).slice(0, 2)) {
              const label = line.words.find(word => /^date:?$/i.test(word.text));
              const value = label && valueAfter(label, words);
              if (!value) continue;
              await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789/-.' });
              const rectangle = valueRectangle(value, header.scale, bitmap, 0, Math.ceil);
              const focused = await worker.recognize(detailImage(bitmap, rectangle, 10).canvas);
              let date = focused.data.text.trim();
              const dateShape = /^\d{1,4}[/-]\d{1,2}[/-]\d{2,4}$|^\d{1,2}[/-]\d{5,6}$/;
              if (!dateShape.test(date)) {
                const alternate = await worker.recognize(detailImage(bitmap, rectangle, 8, { red: true, threshold: 180, padding: 30 }).canvas);
                date = alternate.data.text.trim();
              }
              if (dateShape.test(date)) text += `\n${/receipt|purchase|transaction|sale/i.test(line.text) ? 'Receipt date' : 'Date'}: ${date}`;
            }
          }
          if (!parsed.amount) {
            await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, tessedit_char_whitelist: '' });
            const top = Math.floor(bitmap.height * 0.68);
            const footer = detailImage(bitmap, { left: 0, top, width: bitmap.width, height: bitmap.height - top }, 5);
            const read = await worker.recognize(footer.canvas, {}, { text: true, blocks: true });
            const words = wordsIn(read);
            let focusedTotal = false;
            for (const label of words.filter(word => /^total:?$/i.test(word.text)).slice(0, 2)) {
              const value = valueAfter(label, words);
              if (!value) continue;
              await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.,' });
              const focused = await worker.recognize(detailImage(bitmap, valueRectangle(value, footer.scale, bitmap, top), 10).canvas);
              const amount = focused.data.text.trim();
              if (/^\d{1,9}[.,]\d{1,3}$/.test(amount)) {
                const dollar = words.some(word => /\$/.test(word.text) && word.bbox.x0 > label.bbox.x1 && Math.min(word.bbox.y1,label.bbox.y1)>Math.max(word.bbox.y0,label.bbox.y0));
                text += `\nTOTAL ${dollar ? '$ ' : ''}${amount}`; focusedTotal = true;
              }
            }
            if (!focusedTotal) text += '\n' + read.data.text;
          }
        }
      } catch { /* Keep the first read available if a detail retry cannot finish. */ }
      finally { bitmap.close(); }
    }
    send({ type: 'recognized', text });
  } catch { send({ type: 'failed' }); }
  finally { if (worker) await worker.terminate().catch(() => {}); }
});
parent.postMessage({ type: 'ready' }, location.origin);
