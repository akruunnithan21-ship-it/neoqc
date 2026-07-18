/*
  invoice-ocr.js — OCR fallback for invoices whose PDF text isn't extractable
  (embedded subset fonts with no ToUnicode map — e.g. the NeoTokyo invoice
  generator).

  Split across the two Electron processes, because neither can do it alone:
    • RENDERER (this file): pdf.js rasterises each page to a Chromium canvas.
      (Rendering needs a real canvas, which the main process doesn't have.)
    • MAIN process ('invoice:ocr-images' IPC): tesseract.js reads the page
      images. (OCR needs Node worker_threads, which the renderer's V8 forbids —
      "The V8 platform ... does not support creating Workers".)

  Everything is bundled offline (assets/ocr/ + node_modules, asarUnpacked), so a
  shop PC just runs the installed app — no Python, no downloads, no install.

  nodeIntegration is true, so require() works in the renderer.
*/
(function () {
  var path = require('path');
  var fs = require('fs');
  var urlMod = require('url');
  var ipcRenderer = require('electron').ipcRenderer;

  function ocrDir() {
    var base = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
    return path.join(base, 'assets', 'ocr');
  }
  function fileUrl(p) { return urlMod.pathToFileURL(p).href; }

  // Render every page of the PDF to a canvas element (renderer / Chromium).
  async function renderPdfToCanvases(fileData, scale) {
    var pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = fileUrl(path.join(ocrDir(), 'pdf.worker.js'));
    var doc = await pdfjsLib.getDocument({ data: fileData, isEvalSupported: false }).promise;
    var canvases = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var viewport = page.getViewport({ scale: scale || 2.5 });
      var canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      canvases.push(canvas);
    }
    return canvases;
  }

  function canvasToPngBuffer(canvas) {
    var b64 = canvas.toDataURL('image/png').split(',')[1];
    return Buffer.from(b64, 'base64');
  }

  // Public: OCR a PDF file path -> text. onProgress(statusStr, progress0to1|null).
  async function extractTextByOcr(filePath, onProgress) {
    var data = new Uint8Array(fs.readFileSync(filePath));
    if (onProgress) onProgress('rendering pages', null);
    var canvases = await renderPdfToCanvases(data, 2.5);
    var images = canvases.map(canvasToPngBuffer);

    if (onProgress) onProgress('starting OCR engine', null);
    // Stream per-page/engine progress from the main process while it OCRs.
    var progHandler = function (_e, m) { if (onProgress && m) onProgress(m.status, m.progress); };
    ipcRenderer.on('invoice:ocr-progress', progHandler);
    try {
      var res = await ipcRenderer.invoke('invoice:ocr-images', images);
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'OCR failed in main process');
      return res.text;
    } finally {
      ipcRenderer.removeListener('invoice:ocr-progress', progHandler);
    }
  }

  // Heuristic: does extracted text carry enough real characters to trust it,
  // or is it empty / glyph garbage (control chars) → OCR needed.
  function textIsUsable(text) {
    if (!text) return false;
    var alnum = (text.match(/[A-Za-z0-9]/g) || []).length;
    return alnum >= 40;
  }

  var api = {
    extractTextByOcr: extractTextByOcr,
    renderPdfToCanvases: renderPdfToCanvases,
    textIsUsable: textIsUsable
  };
  if (typeof window !== 'undefined') window.NeoQcInvoiceOcr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
