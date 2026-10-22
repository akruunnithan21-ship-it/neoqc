/*
  Neo Tokyo Operations — the photo tray and the photo gallery.

  Two halves of the same evidence, so one file:
    - the TRAY holds photos in memory BEFORE the thing they belong to exists
      (the intake form takes condition photos before the ticket has an id), and
    - the GALLERY shows them once they are stored.

  Why a tray instead of uploading on pick: an intake photo has nowhere to go
  until the ticket is created, and a photo that failed to upload must not
  vanish — it is the shop's only proof of the condition a machine came in
  with. So files stay in memory (object URLs for previews) until uploadAll
  succeeds for each one; the ones that fail stay in the tray to retry.

  Plain browser global (window.NeoQcPhotoTray), loaded after ops-data.js and
  before service-intake.js. Uploads go through NeoQcData.uploadMedia only —
  this file never talks to Supabase. Anything a person typed (remarks, names)
  is put on screen with textContent; nothing untrusted goes through innerHTML.

  API
    create(host, {roles, defaultRole, allowPdf, minPhotos, label}) -> tray
      tray.files()   [{file, role, remark, previewUrl, error}]
      tray.count() / clear() / destroy() / onChange(fn) -> unsubscribe
      tray.retain(failed)  keep exactly these entries (by file), with their errors
      tray.addFiles(fileList), tray.lock(bool), tray.isShort(), tray.roles()
    uploadAll(tray, {jobId?|caseId?, itemId?}, onProgress(done, total, info))
      -> {ok: n, failed: [{file, role, remark, error}]}
    gallery(host, rows, {editable, onRemark, onVisible, onDelete, canDelete,
                         markRma, urls, emptyText}) -> {refresh(rows)}
      onRemark/onVisible/onDelete may return a promise. A rejection is shown
      to the user by the gallery; a handler that already showed its own
      message resolves false (or throws an error with reported = true).
*/
(function () {
  'use strict';

  var MAX_BYTES = 15 * 1024 * 1024;
  // SPEC-GAP: the spec sets no cap per tray. Thirty full-size photos is already
  // ~100 MB held in memory before upload; past that, one careless drag of a whole
  // camera folder would freeze the renderer.
  var MAX_PER_TRAY = 30;

  var ROLE_LABELS = {
    condition: 'Condition',
    serial_label: 'Serial label',
    invoice: 'Invoice',
    damage: 'Damage',
    packing: 'Packing',
    unboxing: 'Unboxing',
    during: 'During the work',
    after: 'After the work',
    vendor_doc: 'Vendor document',
    return_condition: 'Return condition',
    other: 'Other'
  };
  // Never shown to the customer. The database refuses customer_visible on these
  // too (service_media_private_roles); hiding the tick just stops a click that
  // could only ever fail.
  var PRIVATE_ROLES = { invoice: true, serial_label: true, vendor_doc: true };
  // The only roles a PDF may carry (the data layer enforces the same rule).
  var PDF_ROLES = { invoice: true, vendor_doc: true };
  var TYPE_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf'
  };
  var IMAGE_TYPES = {
    'image/jpeg': 'image', 'image/jpg': 'image', 'image/pjpeg': 'image',
    'image/png': 'image', 'image/webp': 'image',
    'image/heic': 'heic', 'image/heif': 'heic'
  };

  var live = [];            // internals of every tray not yet destroyed
  var traySeq = 0;
  var entrySeq = 0;
  var camOwner = null;      // the one tray whose webcam is open, if any
  var guardsOn = false;

  // ── small helpers ──────────────────────────────────────────────────────────
  function UI() { return (typeof window !== 'undefined' && window.NeoQcUI) || null; }
  function D() { return (typeof window !== 'undefined' && window.NeoQcData) || null; }

  function isDemoErr(e) {
    return !!e && (e === 'DEMO_READONLY' || e.message === 'DEMO_READONLY');
  }

  function errText(e) {
    var u = UI();
    if (u && typeof u.errText === 'function') {
      try { var t = u.errText(e); if (t) return String(t); } catch (x) { /* fall through to the local copy */ }
    }
    if (isDemoErr(e)) return 'Demo data is read-only. Turn it off in Settings to work on real tickets.';
    var m = (e && (e.message || e.error_description || e.details)) || (typeof e === 'string' ? e : '') || 'Something went wrong.';
    m = String(m);
    var neo = /^NEO_[A-Z_]+:\s*([\s\S]*)$/.exec(m);
    if (neo) return neo[1];
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(m)) {
      return 'Couldn’t reach the server. Check the internet connection and try again.';
    }
    return m;
  }

  function toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type || 'info');
  }

  // Build an element without ever parsing a string as HTML. `text` sets
  // textContent; every other key is a plain attribute.
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'cls') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // 'image' | 'heic' | 'pdf' | null. Windows hands HEIC (and sometimes JPEG from
  // a phone link) over with an EMPTY type, so the extension is the fallback.
  function fileKind(file) {
    if (!file) return null;
    var t = String(file.type || '').toLowerCase();
    var x = extOf(file.name);
    if (t === 'application/pdf') return 'pdf';
    if (IMAGE_TYPES[t]) return IMAGE_TYPES[t];
    if (!t || t === 'application/octet-stream') {
      if (x === 'pdf') return 'pdf';
      if (x === 'heic' || x === 'heif') return 'heic';
      if (x === 'jpg' || x === 'jpeg' || x === 'png' || x === 'webp') return 'image';
    }
    return null;
  }

  // Give a type-less file its real type, so the data layer's own type check
  // (which reads file.type) accepts what the tray already accepted.
  function withType(file, kind) {
    var t = String(file.type || '').toLowerCase();
    if (t && t !== 'application/octet-stream' && t !== 'image/jpg' && t !== 'image/pjpeg') return file;
    var want = kind === 'pdf' ? 'application/pdf'
             : (TYPE_BY_EXT[extOf(file.name)] || 'image/jpeg');
    try { return new File([file], file.name || ('photo.' + (extOf(file.name) || 'jpg')), { type: want, lastModified: file.lastModified || Date.now() }); }
    catch (e) { return file; }
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    var u = UI();
    if (u && typeof u.fmtDateTime === 'function') { try { return u.fmtDateTime(iso); } catch (e) { /* local copy below */ } }
    try {
      return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function roleLabel(r) { return ROLE_LABELS[r] || (r ? String(r) : 'Photo'); }

  // A stored row's role as people should read it: older rows have no role and
  // only a phase, and an intake-phase photo IS a condition photo.
  function displayedRole(row) {
    if (!row) return 'other';
    if (row.role) return row.role;
    if (row.phase === 'intake') return 'condition';
    return row.phase || 'other';
  }

  function myRole(module) {
    var d = D();
    if (d && typeof d.role === 'function') { try { return d.role(module); } catch (e) { return null; } }
    var p = (typeof currentProfile !== 'undefined' && currentProfile) || null;
    return p && Number(p.tier) >= 3 ? 'lead' : null;
  }
  // Deleting evidence is a lead's call in either module (the RLS says the same).
  function isLeadAnywhere() { return myRole('service') === 'lead' || myRole('rma') === 'lead'; }

  function openExternal(url) {
    // Signed storage URLs are https; anything else is not ours to open.
    if (!url || !/^https:\/\//i.test(String(url))) return false;
    try {
      var el = (typeof require === 'function') ? require('electron') : null;
      if (el && el.shell && typeof el.shell.openExternal === 'function') { el.shell.openExternal(String(url)); return true; }
    } catch (e) { /* not in Electron: the browser fallback below */ }
    try { window.open(String(url), '_blank', 'noopener'); return true; } catch (e) { return false; }
  }

  // The modal that is actually in front: the highest z-index among open
  // overlays, and the later one on a tie (that is the paint order). A confirm
  // box on top means nothing underneath may react.
  function topOverlay() {
    if (document.querySelector('.neo-confirm-overlay')) return 'blocked';
    var list = document.querySelectorAll('.modal-overlay.active');
    var best = null, bestZ = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var z = parseInt(window.getComputedStyle(list[i]).zIndex, 10);
      if (isNaN(z)) z = 0;
      if (z >= bestZ) { best = list[i]; bestZ = z; }
    }
    return best;
  }

  function hasFiles(dt) {
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }

  function clipFiles(cd) {
    var out = [];
    if (!cd) return out;
    var i;
    if (cd.files && cd.files.length) {
      for (i = 0; i < cd.files.length; i++) out.push(cd.files[i]);
    } else if (cd.items) {
      for (i = 0; i < cd.items.length; i++) {
        var it = cd.items[i];
        if (it && it.kind === 'file') { var f = it.getAsFile(); if (f) out.push(f); }
      }
    }
    return out;
  }

  function stopStream(stream) {
    if (!stream) return;
    try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already stopped */ } }); }
    catch (e) { /* not a MediaStream */ }
  }

  function camError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera access was blocked. Allow the camera for this app and try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No webcam was found on this PC.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'The webcam is busy in another app. Close that app and try again.';
    return 'Couldn’t start the webcam: ' + errText(e);
  }

  // ── document-level guards (installed once, active only while a tray is live)
  // Paste is caught on the DOCUMENT, not on the modal: with nothing focused the
  // paste event targets <body>, which is outside every modal, so a listener on
  // the modal itself would miss the commonest case (screenshot, then Ctrl+V).
  function onPaste(e) {
    var files = clipFiles(e.clipboardData);
    if (!files.length) return;                       // plain text: leave it alone
    var cands = live.filter(function (t) { return t.accepting(); });
    if (!cands.length) return;
    var target = null, i;
    for (i = 0; i < cands.length; i++) if (cands[i].root.contains(e.target)) target = cands[i];
    if (!target) {
      // Several trays in one form (one per item): the one last touched wins, so
      // a paste lands on the item being worked on, not always on item 1.
      cands.sort(function (a, b) {
        if (b.lastTouch !== a.lastTouch) return b.lastTouch - a.lastTouch;
        return (a.root.compareDocumentPosition(b.root) & 4) ? -1 : 1;   // DOM order
      });
      target = cands[0];
    }
    e.preventDefault();
    target.addFiles(files, 'paste');
  }

  // A file dropped just outside a drop zone makes Electron NAVIGATE to it,
  // throwing away the whole half-filled form. While a tray is on screen, an
  // unhandled file drop is refused instead. Drop zones elsewhere in the app call
  // preventDefault themselves, so they are left untouched.
  function onDocDragOver(e) {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    if (!live.some(function (t) { return t.visible(); })) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'none'; } catch (x) { /* read-only in some drags */ }
  }
  function onDocDrop(e) {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    if (!live.some(function (t) { return t.visible(); })) return;
    e.preventDefault();
  }

  function installGuards() {
    if (guardsOn) return;
    guardsOn = true;
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDocDragOver);
    document.addEventListener('drop', onDocDrop);
  }

  // ── the tray ───────────────────────────────────────────────────────────────
  function create(host, opts) {
    if (!host || !host.appendChild) throw new Error('NeoQcPhotoTray.create needs a host element.');
    opts = opts || {};
    var roles = (Array.isArray(opts.roles) ? opts.roles : []).filter(function (r) { return !!ROLE_LABELS[r]; });
    if (!roles.length) roles = ['condition'];
    var defaultRole = roles.indexOf(opts.defaultRole) !== -1 ? opts.defaultRole : roles[0];
    var pdfRoles = roles.filter(function (r) { return PDF_ROLES[r]; });
    var allowPdf = !!opts.allowPdf && pdfRoles.length > 0;
    var minPhotos = Math.max(0, parseInt(opts.minPhotos, 10) || 0);
    var label = opts.label ? String(opts.label) : 'Photos';

    var T = {
      id: ++traySeq,
      entries: [],
      listeners: [],
      locked: false,
      busy: false,
      destroyed: false,
      lastTouch: 0,
      cam: null
    };

    var accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif' +
                 (allowPdf ? ',application/pdf,.pdf' : '');

    var countEl = h('span', { cls: 'svi-tray-count', 'aria-live': 'polite' });
    var input = h('input', { type: 'file', multiple: true, accept: accept, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    var pickBtn = h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'pick', text: 'Choose files' });
    var hasCam = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    var camBtn = hasCam ? h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'cam', text: 'Use webcam' }) : null;
    var drop = h('div', { cls: 'svi-drop' }, [
      h('span', { cls: 'svi-drop-text', text: allowPdf
        ? 'Drop photos or PDFs here, paste with Ctrl+V, or'
        : 'Drop photos here, paste with Ctrl+V, or' }),
      pickBtn, camBtn, input
    ]);
    var video = h('video', { playsinline: true, muted: true, 'aria-label': 'Webcam preview' });
    video.muted = true;
    var capBtn = h('button', { type: 'button', cls: 'primary-pink-btn svi-btn-sm', 'data-act': 'capture', text: 'Capture', disabled: true });
    var camCloseBtn = h('button', { type: 'button', cls: 'secondary-btn svi-btn-sm', 'data-act': 'camclose', text: 'Close' });
    var camMsg = h('span', { cls: 'svi-cam-msg', role: 'status' });
    var camBox = h('div', { cls: 'svi-cam hidden' }, [
      video,
      h('div', { cls: 'svi-cam-bar' }, [capBtn, camCloseBtn, camMsg])
    ]);
    var msgEl = h('div', { cls: 'svi-tray-msg', role: 'status', 'aria-live': 'polite' });
    var thumbs = h('div', { cls: 'svi-thumbs' });
    var root = h('div', { cls: 'svi-tray', 'data-tray': String(T.id) }, [
      h('div', { cls: 'svi-tray-head' }, [h('span', { cls: 'svi-tray-label', text: label }), countEl]),
      drop, camBox, msgEl, thumbs
    ]);
    host.appendChild(root);
    T.root = root;

    function isDisabled() {
      return T.locked || T.busy || T.destroyed || !!root.closest('fieldset[disabled]');
    }
    function visible() {
      if (T.destroyed || !root.isConnected || !root.getClientRects().length) return false;
      var ov = root.closest('.modal-overlay');
      return ov ? ov.classList.contains('active') : true;
    }
    // May this tray take a paste right now? Only when it is on screen, usable,
    // and inside the modal that is actually in front.
    function accepting() {
      if (isDisabled() || !visible()) return false;
      var top = topOverlay();
      if (top === 'blocked') return false;
      var ov = root.closest('.modal-overlay');
      if (ov) return ov === top;
      return top === null;
    }
    T.visible = visible;
    T.accepting = accepting;
    T.addFiles = function (list, source) { return addFiles(list, source); };   // the document paste router calls this

    function say(text, kind) {
      msgEl.textContent = text || '';
      msgEl.className = 'svi-tray-msg' + (kind ? ' ' + kind : '');
    }

    function emit() {
      T.listeners.slice().forEach(function (fn) {
        try { fn(api); } catch (e) { console.warn('photo tray listener failed:', e && e.message); }
      });
    }

    function updateCount() {
      var n = T.entries.length;
      var txt = n === 0 ? 'No photos yet' : (n === 1 ? '1 photo' : n + ' photos');
      if (minPhotos > 0 && n < minPhotos) txt += ' · at least ' + minPhotos + ' needed';
      countEl.textContent = txt;
      root.classList.toggle('is-short', minPhotos > 0 && n < minPhotos);
      root.classList.toggle('has-photos', n > 0);
    }

    function findEntry(id) {
      for (var i = 0; i < T.entries.length; i++) if (T.entries[i].id === id) return T.entries[i];
      return null;
    }

    function isDup(f) {
      return T.entries.some(function (e) {
        return e.file.name === f.name && e.file.size === f.size && e.file.lastModified === f.lastModified;
      });
    }

    function roleOptionsFor(entry) {
      return entry.kind === 'pdf' ? pdfRoles : roles;
    }

    function renderEntry(entry) {
      var pic;
      if (entry.kind === 'image' && entry.previewUrl) {
        var img = h('img', { src: entry.previewUrl, alt: '', draggable: 'false' });
        img.addEventListener('error', function () {
          // A corrupt or unsupported image: say so instead of a broken icon.
          var tile = h('span', { cls: 'svi-th-doc', text: 'No preview' });
          if (img.parentNode) img.parentNode.replaceChild(tile, img);
        });
        pic = h('button', { type: 'button', cls: 'svi-th-pic', 'data-act': 'view', 'aria-label': 'View this photo larger', title: entry.file.name }, [img]);
      } else {
        pic = h('div', { cls: 'svi-th-pic is-doc', title: entry.file.name }, [
          h('span', { cls: 'svi-th-doc' }, [
            h('strong', { text: entry.kind === 'pdf' ? 'PDF' : 'iPhone photo (HEIC)' }),
            h('span', { text: entry.file.name })
          ])
        ]);
      }
      var sel = h('select', { cls: 'settings-select svi-th-role', 'aria-label': 'What this photo shows' });
      roleOptionsFor(entry).forEach(function (r) {
        var o = h('option', { value: r, text: roleLabel(r) });
        if (r === entry.role) o.selected = true;
        sel.appendChild(o);
      });
      var remark = h('input', {
        type: 'text', cls: 'svi-th-remark', maxlength: '300', autocomplete: 'off',
        placeholder: 'Remark — e.g. dent on the rear-left', 'aria-label': 'Remark for this photo'
      });
      remark.value = entry.remark || '';
      var x = h('button', { type: 'button', cls: 'svi-th-x', 'data-act': 'remove', 'aria-label': 'Remove this photo', title: 'Remove this photo' });
      x.textContent = '\u00d7';
      var err = h('div', { cls: 'svi-th-err', role: 'alert' });
      var card = h('div', { cls: 'svi-th', 'data-entry': entry.id }, [pic, x, sel, remark, err]);
      entry.el = card;
      paintError(entry);
      thumbs.appendChild(card);
    }

    function paintError(entry) {
      if (!entry.el) return;
      var err = entry.el.querySelector('.svi-th-err');
      if (err) err.textContent = entry.error ? 'Not uploaded: ' + entry.error : '';
      entry.el.classList.toggle('has-error', !!entry.error);
    }

    function dropEntry(entry) {
      if (entry.previewUrl) { try { URL.revokeObjectURL(entry.previewUrl); } catch (e) { /* already revoked */ } }
      entry.previewUrl = null;
      if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      entry.el = null;
    }

    function removeEntry(id, silent) {
      var e = findEntry(id);
      if (!e) return false;
      T.entries = T.entries.filter(function (x) { return x.id !== id; });
      dropEntry(e);
      updateCount();
      if (!silent) emit();
      return true;
    }

    function addFiles(list, source) {
      if (T.destroyed) return 0;
      if (isDisabled()) { say('Photos can’t be added right now.', 'err'); return 0; }
      var files = Array.prototype.slice.call(list || []);
      var added = 0, problems = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f) continue;
        if (T.entries.length >= MAX_PER_TRAY) { problems.push('A tray holds up to ' + MAX_PER_TRAY + ' photos.'); break; }
        var kind = fileKind(f);
        var nm = f.name || 'That file';
        if (!kind) {
          problems.push(nm + ' isn’t a JPEG, PNG, WebP or HEIC photo' + (allowPdf ? ' or a PDF' : '') + '.');
          continue;
        }
        if (kind === 'pdf' && !allowPdf) { problems.push(nm + ': PDFs are only for invoices and vendor documents.'); continue; }
        if (f.size > MAX_BYTES) { problems.push(nm + ' is over 15 MB.'); continue; }
        if (!f.size) { problems.push(nm + ' is empty.'); continue; }
        if (source === 'paste') {
          // Clipboard images all arrive as "image.png"; give each its own name so
          // the list (and any error) says which one it is.
          try { f = new File([f], 'pasted-' + stamp() + '-' + (entrySeq + 1) + '.' + (extOf(f.name) || 'png'), { type: f.type || 'image/png', lastModified: Date.now() }); }
          catch (e) { /* keep the original name */ }
        } else if (source !== 'webcam' && isDup(f)) {
          problems.push(nm + ' is already in the tray.');
          continue;
        }
        f = withType(f, kind);
        var role = defaultRole;
        if (kind === 'pdf') role = PDF_ROLES[defaultRole] ? defaultRole : pdfRoles[0];
        var entry = {
          id: 'pe' + (++entrySeq),
          file: f,
          kind: kind,
          role: role,
          remark: '',
          error: '',
          // HEIC cannot be decoded by Chromium and a PDF is not an image: no
          // object URL for either, so there is nothing to leak.
          previewUrl: kind === 'image' ? URL.createObjectURL(f) : null,
          el: null
        };
        T.entries.push(entry);
        renderEntry(entry);
        added++;
      }
      // Said once per tray (SPEC-AMENDMENTS A22): HEIC is stored as it is, it
      // just cannot be previewed in this app.
      var heicNote = '';
      if (!T.heicWarned && T.entries.some(function (e) { return e.kind === 'heic'; })) {
        T.heicWarned = true;
        heicNote = 'iPhone HEIC photos can’t be previewed here — choose “Most compatible” in the camera settings to get JPEGs.';
      }
      if (problems.length) say(problems.concat(heicNote ? [heicNote] : []).join(' '), 'err');
      else if (heicNote) say(heicNote, '');
      else if (added) say(added === 1 ? 'Photo added.' : added + ' photos added.', 'ok');
      if (added) { updateCount(); emit(); }
      return added;
    }

    // ── webcam ──
    function closeCam() {
      var s = T.cam;
      if (!s) return;
      s.closed = true;
      clearInterval(s.watch);
      stopStream(s.stream);
      try { video.pause(); } catch (e) { /* not playing */ }
      try { video.srcObject = null; } catch (e) { /* older engines */ }
      T.cam = null;
      if (camOwner === T) camOwner = null;
      camBox.classList.add('hidden');
      capBtn.disabled = true;
      camMsg.textContent = '';
      if (camBtn) camBtn.disabled = false;
    }
    T.closeCam = closeCam;

    function openCam() {
      if (isDisabled() || T.cam) return;
      if (!hasCam) { say('This PC can’t use a webcam here.', 'err'); return; }
      if (camOwner && camOwner !== T) camOwner.closeCam();      // one camera at a time
      var session = { stream: null, closed: false, watch: null };
      T.cam = session;
      camOwner = T;
      camBox.classList.remove('hidden');
      capBtn.disabled = true;
      if (camBtn) camBtn.disabled = true;
      camMsg.textContent = 'Starting the camera…';
      // SPEC-GAP: the spec says {video: true}. An "ideal" size is still exactly
      // that (it never fails when the camera can't meet it) but stops Chromium
      // defaulting to 640x480, which is too soft to read a serial label.
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
        .then(function (stream) {
          // Closed, destroyed or reopened while the permission prompt was up:
          // this stream belongs to nobody, so the light must go off now.
          if (session.closed || T.destroyed || T.cam !== session) { stopStream(stream); return; }
          session.stream = stream;
          video.srcObject = stream;
          var p = video.play();
          if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay of a muted stream does not fail in practice */ });
          capBtn.disabled = false;
          camMsg.textContent = '';
        })
        .catch(function (e) {
          if (session.closed || T.cam !== session) return;
          closeCam();
          say(camError(e), 'err');
        });
      // The modal can be closed or its contents repainted without anybody
      // calling close() or destroy(). A webcam light left on is a privacy
      // problem, so the tray checks for itself.
      session.watch = setInterval(function () {
        if (T.cam === session && (!visible() || isDisabled())) closeCam();
      }, 1000);
    }

    function capture() {
      var s = T.cam;
      if (!s || !s.stream) return;
      var w = video.videoWidth, ht = video.videoHeight;
      if (!w || !ht) { camMsg.textContent = 'The camera is still starting.'; return; }
      var c = document.createElement('canvas');
      c.width = w; c.height = ht;
      try { c.getContext('2d').drawImage(video, 0, 0, w, ht); }
      catch (e) { camMsg.textContent = 'Couldn’t take the picture. Try again.'; return; }
      capBtn.disabled = true;
      c.toBlob(function (blob) {
        if (T.destroyed) return;
        if (T.cam === s) capBtn.disabled = false;
        if (!blob) { camMsg.textContent = 'Couldn’t take the picture. Try again.'; return; }
        var f;
        try { f = new File([blob], 'webcam-' + stamp() + '-' + (entrySeq + 1) + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }); }
        catch (e) { camMsg.textContent = 'Couldn’t take the picture. Try again.'; return; }
        if (addFiles([f], 'webcam')) {
          camMsg.textContent = 'Captured. Take another or close the camera.';
          root.classList.add('svi-flash');
          setTimeout(function () { root.classList.remove('svi-flash'); }, 180);
        }
      }, 'image/jpeg', 0.92);
    }

    function viewEntry(id) {
      var imgs = T.entries.filter(function (e) { return e.kind === 'image' && e.previewUrl; });
      var idx = -1;
      for (var i = 0; i < imgs.length; i++) if (imgs[i].id === id) idx = i;
      if (idx < 0) return;
      var u = UI();
      if (!u || typeof u.lightbox !== 'function') return;
      u.lightbox(imgs.map(function (e) {
        return { url: e.previewUrl, title: roleLabel(e.role), sub: (e.remark || '').trim() || e.file.name };
      }), idx);
    }

    // ── events (all delegated on the tray root) ──
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !root.contains(b)) return;
      var act = b.getAttribute('data-act');
      if (act === 'pick') { if (!isDisabled()) input.click(); return; }
      if (act === 'cam') { openCam(); return; }
      if (act === 'capture') { capture(); return; }
      if (act === 'camclose') { closeCam(); return; }
      var card = b.closest('.svi-th');
      if (!card) return;
      if (act === 'remove') { if (!isDisabled()) { removeEntry(card.getAttribute('data-entry')); say('', ''); } return; }
      if (act === 'view') { viewEntry(card.getAttribute('data-entry')); }
    });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';                       // allow picking the same file again
      if (files.length) addFiles(files, 'pick');
    });
    root.addEventListener('change', function (e) {
      if (!e.target.classList.contains('svi-th-role')) return;
      var card = e.target.closest('.svi-th');
      var en = card && findEntry(card.getAttribute('data-entry'));
      if (en) { en.role = e.target.value; emit(); }
    });
    root.addEventListener('input', function (e) {
      if (!e.target.classList.contains('svi-th-remark')) return;
      var card = e.target.closest('.svi-th');
      var en = card && findEntry(card.getAttribute('data-entry'));
      if (en) { en.remark = e.target.value; emit(); }
    });
    // Scanner rule: Enter in a remark must never reach a button or a form.
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') e.preventDefault();
    });
    var touch = function () { T.lastTouch = Date.now(); };
    root.addEventListener('pointerdown', touch);
    root.addEventListener('focusin', touch);

    var dragDepth = 0;
    root.addEventListener('dragenter', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth++;
      if (!isDisabled()) root.classList.add('is-over');
    });
    root.addEventListener('dragover', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = isDisabled() ? 'none' : 'copy'; } catch (x) { /* read-only */ }
    });
    root.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) root.classList.remove('is-over');
    });
    root.addEventListener('drop', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth = 0;
      root.classList.remove('is-over');
      touch();
      addFiles(e.dataTransfer.files, 'drop');
    });

    // ── public surface ──
    var api = {
      files: function () {
        return T.entries.map(function (e) {
          return { file: e.file, role: e.role, remark: String(e.remark || '').trim(), previewUrl: e.previewUrl, error: e.error || '' };
        });
      },
      count: function () { return T.entries.length; },
      clear: function () {
        if (T.destroyed) return;
        T.entries.forEach(dropEntry);
        T.entries = [];
        say('', '');
        updateCount();
        emit();
      },
      destroy: function () {
        if (T.destroyed) return;
        closeCam();
        T.entries.forEach(dropEntry);
        T.entries = [];
        T.destroyed = true;
        T.listeners = [];
        live = live.filter(function (t) { return t !== T; });
        if (root.parentNode) root.parentNode.removeChild(root);
      },
      onChange: function (fn) {
        if (typeof fn !== 'function') return function () {};
        T.listeners.push(fn);
        return function () { T.listeners = T.listeners.filter(function (x) { return x !== fn; }); };
      },
      // Keep exactly the entries whose file is in `failed` (as returned by
      // uploadAll), each showing why it did not upload. Everything else goes.
      retain: function (failed) {
        if (T.destroyed) return;
        var keep = (failed || []).filter(function (f) { return f && f.file; });
        T.entries = T.entries.filter(function (e) {
          var hit = null;
          for (var i = 0; i < keep.length; i++) if (keep[i].file === e.file) { hit = keep[i]; break; }
          if (!hit) { dropEntry(e); return false; }
          e.error = hit.error ? String(hit.error) : (e.error || 'Upload failed.');
          if (hit.role && roleOptionsFor(e).indexOf(hit.role) !== -1) e.role = hit.role;
          paintError(e);
          return true;
        });
        updateCount();
        emit();
      },
      addFiles: function (list) { return addFiles(list, 'pick'); },
      lock: function (on) {
        T.locked = !!on;
        root.classList.toggle('is-locked', T.locked || T.busy);
        if (T.locked) closeCam();
        syncDisabled();
      },
      isShort: function () { return T.entries.length < minPhotos; },
      roles: function () { return roles.slice(); },
      element: root,
      // internals for uploadAll — not for other modules
      _entries: function () { return T.entries.slice(); },
      _has: function (id) { return !!findEntry(id); },
      _remove: function (id) { return removeEntry(id, false); },
      _setError: function (id, msg) { var en = findEntry(id); if (en) { en.error = msg || ''; paintError(en); } },
      _isDestroyed: function () { return T.destroyed; },
      _busy: function () { return T.busy; },
      _setBusy: function (on) {
        T.busy = !!on;
        root.classList.toggle('is-locked', T.locked || T.busy);
        if (T.busy) closeCam();
        syncDisabled();
      }
    };

    function syncDisabled() {
      var off = T.locked || T.busy;
      root.querySelectorAll('button, select, input').forEach(function (el) {
        if (el === input) return;
        if (off) { if (!el.disabled) { el.disabled = true; el.setAttribute('data-tray-off', '1'); } }
        else if (el.getAttribute('data-tray-off') === '1') { el.disabled = false; el.removeAttribute('data-tray-off'); }
      });
      if (!off) capBtn.disabled = !(T.cam && T.cam.stream);
    }

    updateCount();
    live.push(T);
    installGuards();
    return api;
  }

  // ── upload ─────────────────────────────────────────────────────────────────
  // Sequential on purpose: a counter PC on shop Wi-Fi uploading eight 4 MB
  // photos at once times every one of them out; one at a time, each finishes.
  async function uploadAll(tray, target, onProgress) {
    if (!tray || typeof tray._entries !== 'function') throw new Error('uploadAll needs a tray made by NeoQcPhotoTray.create.');
    // Bound once. The caller's panel can move on to another job while this
    // runs; the photos must still land on the job they were taken for.
    var t = target || {};
    var jobId = t.jobId || null, caseId = t.caseId || null, itemId = t.itemId || null;
    if (!jobId && !caseId) throw new Error('uploadAll needs a jobId or a caseId.');
    var data = D();
    if (!data || typeof data.uploadMedia !== 'function') throw new Error('The data layer is not loaded.');
    if (tray._busy()) throw new Error('These photos are already uploading.');

    var batch = tray._entries();
    var total = batch.length, ok = 0, failed = [], stopWith = null;
    var report = function (done, info) {
      if (typeof onProgress !== 'function') return;
      try { onProgress(done, total, info || {}); } catch (e) { /* a progress painter must not stop the upload */ }
    };
    if (!total) { report(0, { ok: 0, failed: 0 }); return { ok: 0, failed: [] }; }

    tray._setBusy(true);
    try {
      for (var i = 0; i < batch.length; i++) {
        var e = batch[i];
        var remark = String(e.remark || '').trim();
        if (tray._isDestroyed()) {
          failed.push({ file: e.file, role: e.role, remark: remark, error: 'Not uploaded — the form was closed.' });
          continue;
        }
        if (!tray._has(e.id)) continue;
        report(i, { ok: ok, failed: failed.length, name: e.file.name, role: e.role });
        if (stopWith) {
          failed.push({ file: e.file, role: e.role, remark: remark, error: stopWith });
          tray._setError(e.id, stopWith);
          continue;
        }
        try {
          await data.uploadMedia({
            jobId: jobId, caseId: caseId, itemId: itemId,
            role: e.role, remark: remark || null, file: e.file
          });
          ok++;
          tray._remove(e.id);
        } catch (err) {
          var m = errText(err);
          // Demo mode refuses every write the same way; trying the rest only
          // makes the user wait to read the same sentence N times.
          if (isDemoErr(err)) stopWith = m;
          failed.push({ file: e.file, role: e.role, remark: remark, error: m });
          tray._setError(e.id, m);
        }
      }
    } finally {
      tray._setBusy(false);
    }
    if (!tray._isDestroyed()) tray.retain(failed);
    report(total, { ok: ok, failed: failed.length, done: true });
    return { ok: ok, failed: failed };
  }

  // ── gallery ────────────────────────────────────────────────────────────────
  function rowUrl(row, opts) {
    return row.url || row.signedUrl || row.signed_url || row.signedURL ||
           (opts.urls && row.path ? opts.urls[row.path] : null) || null;
  }
  function rowKind(row) {
    var mime = String(row.mime || row.content_type || row.mime_type || '').toLowerCase();
    var x = extOf(row.path);
    if (row.is_pdf || mime === 'application/pdf' || x === 'pdf') return 'pdf';
    if (row.is_heic || mime === 'image/heic' || mime === 'image/heif' || x === 'heic' || x === 'heif') return 'heic';
    return 'image';
  }

  // A caller's handler that has ALREADY told the user why it failed says so by
  // resolving false, or by throwing an error with `reported = true`; the
  // gallery then only puts its own state back. Any other rejection (a handler
  // that just hands back the data layer's promise, as service.js and rma.js
  // do) has told nobody, so the gallery says why itself.
  function runHandler(fn) {
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) {
      if (v === false) { var err = new Error('not saved'); err.reported = true; throw err; }
      return v;
    });
  }
  function reported(e) { return !!(e && e.reported); }

  function gallery(host, rows, opts) {
    if (!host) return { refresh: function () {} };
    opts = opts || {};
    var list = Array.isArray(rows) ? rows.slice() : [];
    host.textContent = '';
    var root = h('div', { cls: 'svi-gal' });
    host.appendChild(root);

    var editable = !!opts.editable;
    // Deleting is a lead's call, and never on a read-only gallery. A caller that
    // wires its own handlers but leaves out onDelete has decided "no delete
    // here"; only a caller with no handlers at all gets the data-layer default.
    var deleter = typeof opts.onDelete === 'function' ||
      (!opts.onRemark && !opts.onVisible && !!(D() && typeof D().deleteMedia === 'function'));
    var canDelete = typeof opts.canDelete === 'boolean' ? opts.canDelete : isLeadAnywhere();
    var hasDelete = editable && canDelete && deleter;
    // "RMA" marks a part's photo inside a ticket's gallery. In the RMA module's
    // own gallery every row is a part photo, so marking them all would be noise:
    // unless the caller says, mark only when the set is mixed.
    var markRma = typeof opts.markRma === 'boolean'
      ? opts.markRma
      : (list.some(function (r) { return !!r.rma_case_id; }) && list.some(function (r) { return !r.rma_case_id; }));

    if (!list.length) {
      root.appendChild(h('div', { cls: 'svi-gal-empty', text: opts.emptyText || 'No photos yet.' }));
      return { refresh: function (r) { return gallery(host, r, opts); } };
    }

    function viewables() {
      return list.filter(function (r) { return rowKind(r) === 'image' && rowUrl(r, opts); });
    }

    function openRow(row) {
      var url = rowUrl(row, opts);
      if (!url) { toast('This photo has no preview link. Reopen the tab to refresh it.', 'warning'); return; }
      var kind = rowKind(row);
      if (kind !== 'image') {
        // A PDF (or a HEIC Chromium cannot draw) opens in the system viewer.
        if (!openExternal(url)) toast('Couldn’t open that file.', 'error');
        return;
      }
      var imgs = viewables();
      var idx = imgs.indexOf(row);
      var u = UI();
      if (u && typeof u.lightbox === 'function') {
        u.lightbox(imgs.map(function (r) {
          var bits = [];
          if (r.remark) bits.push(String(r.remark));
          var by = r.uploaded_name || r.uploaded_by;
          if (by) bits.push(String(by));
          if (r.created_at) bits.push(fmtWhen(r.created_at));
          return {
            url: rowUrl(r, opts),
            title: roleLabel(displayedRole(r)) + (markRma && r.rma_case_id ? ' · RMA' : ''),
            sub: bits.join(' · ')
          };
        }), idx < 0 ? 0 : idx);
      } else if (!openExternal(url)) {
        toast('Couldn’t open that photo.', 'error');
      }
    }

    function tile(row) {
      var role = displayedRole(row);
      var kind = rowKind(row);
      var url = rowUrl(row, opts);
      var pic;
      if (kind === 'image' && url) {
        var img = h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' });
        img.addEventListener('error', function () {
          // Usually an expired signed link (they last 15 minutes).
          var miss = h('span', { cls: 'svi-g-miss', text: 'No preview' });
          if (img.parentNode) img.parentNode.replaceChild(miss, img);
        });
        pic = img;
      } else if (kind === 'pdf' || kind === 'heic') {
        pic = h('span', { cls: 'svi-g-doc' }, [
          h('strong', { text: kind === 'pdf' ? 'PDF' : 'iPhone photo (HEIC)' }),
          h('span', { text: url ? 'Open' : 'No link yet' })
        ]);
      } else {
        pic = h('span', { cls: 'svi-g-miss', text: 'No preview' });
      }
      var picBtn = h('button', {
        type: 'button', cls: 'svi-g-pic' + (kind !== 'image' ? ' is-doc' : ''),
        'aria-label': kind === 'image' ? 'View this photo larger' : 'Open this document'
      }, [pic]);
      picBtn.addEventListener('click', function () { openRow(row); });

      var badges = h('div', { cls: 'svi-g-badges' }, [
        h('span', { cls: 'svi-role-badge role-' + String(role).replace(/[^a-z_]/g, ''), text: roleLabel(role) }),
        markRma && row.rma_case_id ? h('span', { cls: 'svi-rma-badge', text: 'RMA' }) : null,
        PRIVATE_ROLES[role] ? h('span', { cls: 'svi-private-badge', text: 'Staff only' }) : null
      ]);

      var remarkBox;
      if (editable) {
        var inp = h('input', {
          type: 'text', cls: 'svi-g-remark', maxlength: '300', autocomplete: 'off',
          placeholder: 'Add a remark', 'aria-label': 'Remark for this photo'
        });
        inp.value = row.remark == null ? '' : String(row.remark);
        var state = h('span', { cls: 'svi-g-state', role: 'status' });
        if (row.remark_by) inp.title = 'Remark by ' + row.remark_by + (row.remark_at ? ', ' + fmtWhen(row.remark_at) : '');
        var save = function () { saveRemark(row, inp, state); };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        inp.addEventListener('input', function () {
          if (state.classList.contains('ok')) { state.textContent = ''; state.className = 'svi-g-state'; }
        });
        remarkBox = h('div', { cls: 'svi-g-remark-row' }, [inp, state]);
      } else {
        remarkBox = row.remark ? h('div', { cls: 'svi-g-remark-ro', text: String(row.remark) }) : null;
      }

      var who = row.uploaded_name || row.uploaded_by || '';
      var when = fmtWhen(row.created_at);
      var by = h('div', { cls: 'svi-g-by', text: [who, when].filter(Boolean).join(' · ') });

      var fig = h('figure', { cls: 'svi-g' + (row.customer_visible ? ' shown' : ''), 'data-media': row.id == null ? '' : String(row.id) });

      var foot = h('div', { cls: 'svi-g-foot' });
      if (!PRIVATE_ROLES[role]) {
        if (editable) {
          var cb = h('input', { type: 'checkbox' });
          cb.checked = !!row.customer_visible;
          cb.addEventListener('change', function () { toggleVisible(row, cb, fig); });
          foot.appendChild(h('label', { cls: 'svi-g-vis' }, [cb, 'Show customer']));
        } else if (row.customer_visible) {
          foot.appendChild(h('span', { cls: 'svi-g-vis-ro', text: 'Customer can see' }));
        }
      }
      if (hasDelete) {
        var del = h('button', { type: 'button', cls: 'svi-g-del', text: 'Delete', 'aria-label': 'Delete this photo' });
        del.addEventListener('click', function () { deleteRow(row, del, fig); });
        foot.appendChild(del);
      }

      fig.appendChild(picBtn);
      fig.appendChild(h('figcaption', null, [badges, remarkBox, by, foot.childNodes.length ? foot : null]));
      return fig;
    }

    // Column-scoped on the server (remark, remark_by, remark_at only). The row
    // object is captured by the closure, so a slow save can never land on a
    // different photo even if the gallery is repainted meanwhile.
    function saveRemark(row, inp, state) {
      var v = inp.value.trim();
      var before = row.remark == null ? '' : String(row.remark).trim();
      if (v === before || inp.getAttribute('data-saving') === '1') return;
      var call = null, own = typeof opts.onRemark === 'function';
      if (own) call = function () { return opts.onRemark(row, v); };
      else if (D() && typeof D().setMediaRemark === 'function') call = function () { return D().setMediaRemark(row.id, v); };
      if (!call) { state.textContent = 'Can’t save remarks here.'; state.className = 'svi-g-state err'; return; }
      inp.setAttribute('data-saving', '1');
      state.textContent = 'Saving…';
      state.className = 'svi-g-state';
      runHandler(call).then(function () {
        inp.removeAttribute('data-saving');
        row.remark = v;
        if (!inp.isConnected) return;
        state.textContent = 'Saved';
        state.className = 'svi-g-state ok';
        // They kept typing while it saved: save the newer text too.
        if (inp.value.trim() !== v && document.activeElement !== inp) saveRemark(row, inp, state);
      }, function (e) {
        inp.removeAttribute('data-saving');
        var why = reported(e) ? 'try again' : errText(e);
        // Repainted meanwhile: the inline status is gone, so a failure nobody
        // reported yet becomes a toast.
        if (!inp.isConnected) { if (!reported(e)) toast('A photo remark didn’t save: ' + why, 'error'); return; }
        // The typed text stays in the box; the next blur or Enter tries again.
        state.textContent = 'Didn’t save: ' + why;
        state.className = 'svi-g-state err';
      });
    }

    function toggleVisible(row, cb, fig) {
      var want = cb.checked;
      var call = null, own = typeof opts.onVisible === 'function';
      if (own) call = function () { return opts.onVisible(row, want); };
      else if (D() && typeof D().setMediaVisible === 'function') call = function () { return D().setMediaVisible(row.id, want); };
      if (!call) { cb.checked = !want; return; }
      cb.disabled = true;
      fig.classList.toggle('shown', want);
      runHandler(call).then(function () {
        row.customer_visible = want;
        cb.disabled = false;
      }, function (e) {
        // Put the tick back: a checkbox that silently fails is worse than one
        // that refuses, because the operator believes the photo is shared.
        cb.checked = !want;
        cb.disabled = false;
        fig.classList.toggle('shown', !want);
        if (!reported(e)) toast('Couldn’t change that photo: ' + errText(e), 'error');
      });
    }

    async function deleteRow(row, btn, fig) {
      // Without the app's confirm box there is no safe way to ask; refuse
      // rather than delete evidence on a single click.
      if (typeof showConfirm !== 'function') { toast('Deleting photos isn’t available here.', 'warning'); return; }
      var ok = await showConfirm(
        'Delete this photo? Condition photos are the evidence of how the item arrived. This cannot be undone.',
        { title: 'Delete photo', okText: 'Delete', cancelText: 'Keep it', danger: true });
      if (!ok) return;
      btn.disabled = true;
      var own = typeof opts.onDelete === 'function';
      try {
        await runHandler(function () { return own ? opts.onDelete(row) : D().deleteMedia(row); });
        list = list.filter(function (r) { return r !== row; });
        if (fig.parentNode) fig.parentNode.removeChild(fig);
        if (!list.length && root.isConnected) root.appendChild(h('div', { cls: 'svi-gal-empty', text: opts.emptyText || 'No photos yet.' }));
      } catch (e) {
        btn.disabled = false;
        if (!reported(e)) toast('Couldn’t delete that photo: ' + errText(e), 'error');
      }
    }

    list.forEach(function (row) { if (row) root.appendChild(tile(row)); });
    return { refresh: function (r) { return gallery(host, r, opts); } };
  }

  window.NeoQcPhotoTray = {
    create: create,
    uploadAll: uploadAll,
    gallery: gallery,
    ROLE_LABELS: ROLE_LABELS,
    PRIVATE_ROLES: Object.keys(PRIVATE_ROLES),
    roleLabel: roleLabel,
    displayedRole: displayedRole,
    // exposed for tests
    _fileKind: fileKind
  };
})();
