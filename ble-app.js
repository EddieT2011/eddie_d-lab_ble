/*
 * Eddie D-Lab: phone app for the ESP32-S3-ePaper-1.54G over Web Bluetooth.
 * Design: docs/ESP32-S3-ePaper-1.54G_BLE_Android.md. Firmware stage B1 (T-020) serves only the
 * status characteristic; pictures, sign-in, Wi-Fi and login changes need stages B2 and B5, so those
 * run on the demo board until then. The picture pipeline is tools/epd-image/epd-core.js, unchanged.
 */
(function () {
  'use strict';
  const C = window.EPDCore;
  const $ = id => document.getElementById(id);
  const W = 200, H = 200, THUMB = 100;
  const BMP_BYTES = 120054, UPLOAD_MAX = 130 * 1024; // web_api.cpp UPLOAD_MAX_BYTES
  const SESSION_MS = 20 * 60 * 1000; // Same as the web page login.
  const PREVIEW = !!window.EDDIE_PREVIEW; // Set by build_artifact.py: no Bluetooth, no downloads.

  // GATT layout (design §4). Characteristics differ in hex digits 5-8 of the service UUID.
  const UUID = {
    service: '2b8b0000-4f77-4c68-bd41-fecbe7432412',
    status: '2b8b0001-4f77-4c68-bd41-fecbe7432412',
    images: '2b8b0002-4f77-4c68-bd41-fecbe7432412', // stage B2
    command: '2b8b0003-4f77-4c68-bd41-fecbe7432412', // stage B2
    data: '2b8b0004-4f77-4c68-bd41-fecbe7432412', // stage B2
    wifi: '2b8b0005-4f77-4c68-bd41-fecbe7432412' // stage B5
  };
  const STATUS_PERIOD_MS = 10000; // Read again this often; notify is cut at MTU - 3 bytes (design §4).

  // ---------- storage (per-viewer conveniences only) ----------
  function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- theme: system / light / dark ----------
  const THEMES = ['system', 'light', 'dark'];
  const THEME_ICON = {
    system: '<circle cx="12" cy="12" r="8"></circle><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"></path>',
    light: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>',
    dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"></path>'
  };
  let theme = load('eddie.theme', 'system');
  if (!THEMES.includes(theme)) theme = 'system';
  function applyTheme(t) {
    theme = t; save('eddie.theme', t);
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('themeBtn').setAttribute('aria-label', 'Theme: ' + t + '. Tap to change.');
    $('themeBtn').querySelector('svg').innerHTML = THEME_ICON[t];
    $('themeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === t ? 'true' : 'false'));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#eceee9');
    if (typeof view !== 'undefined' && view === 'history' && typeof drawCharts === 'function') drawCharts();
  }
  $('themeBtn').onclick = () => { applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]); toast('Theme: ' + theme); };
  $('themeSeg').querySelectorAll('button').forEach(b => { b.onclick = () => applyTheme(b.dataset.t); });

  // ---------- toast, confirm sheet ----------
  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function ask(title, text, yesLabel) {
    return new Promise(resolve => {
      $('sheetTitle').textContent = title; $('sheetText').textContent = text; $('sheetYes').textContent = yesLabel;
      $('scrim').hidden = false; $('sheetNo').focus();
      const done = v => { $('scrim').hidden = true; $('sheetYes').onclick = $('sheetNo').onclick = $('scrim').onclick = null; resolve(v); };
      $('sheetYes').onclick = e => { e.stopPropagation(); done(true); };
      $('sheetNo').onclick = e => { e.stopPropagation(); done(false); };
      $('scrim').onclick = e => { if (e.target === $('scrim')) done(false); };
    });
  }
  function setResult(id, kind, text) {
    const el = $(id);
    el.dataset.kind = kind; el.hidden = !text;
    el.textContent = (kind === 'ok' ? '✔ ' : kind === 'err' ? '✘ ' : '') + (text || '');
  }

  // ---------- views (hash routing: #home #images #create #settings) ----------
  const VIEWS = ['home', 'images', 'create', 'settings', 'history'];
  let view = 'home';
  function show(v) {
    if (!VIEWS.includes(v)) v = 'home';
    view = v;
    VIEWS.forEach(n => { $('view-' + n).hidden = n !== v; });
    document.querySelectorAll('.tabs button').forEach(b => {
      if (b.dataset.view === (v === 'history' ? 'home' : v)) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('dock').hidden = v !== 'create';
    document.body.classList.toggle('docked', v === 'create');
    if (v === 'create') render();
    if (v === 'images') renderImages();
    if (v === 'settings') renderSettings();
    if (v === 'history') loadHistory();
  }
  function go(v) { if (location.hash !== '#' + v) location.hash = v; else show(v); window.scrollTo(0, 0); }
  document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => go(b.dataset.view); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  // ---------- boards ----------
  class NeedsFirmware extends Error {
    constructor(stage) { super('The board firmware does not do this over Bluetooth yet (comes with stage ' + stage + '). Use the web page on Wi-Fi for now.'); }
  }
  // An answer "<verb> err <code>" from the board (firmware ble_link.cpp, stage B2).
  const BOARD_ERRORS = {
    bad_login: 'Wrong user name or password.', need_login: 'The sign-in ran out on the board. Sign in again.',
    not_found: 'The card has no picture with that name.', bad_size: 'The file size did not match. Nothing was saved.',
    bad_crc: 'The file arrived damaged. Nothing was saved.', not_saved: 'The board refused the file (name, or not a 200 × 200 24-bit BMP).',
    no_card: 'No SD card in the board.', no_memory: 'The board is out of memory. Restart it and try again.',
    bad_file: 'The picture on the card could not be read.', no_upload: 'The board lost the upload. Send again.',
    bad_value: 'The board refused these values. Nothing changed.', wifi_off: 'Wi-Fi is off on the board right now (it woke on its timer). Restart it with USB plugged in.'
  };
  const PAIR_HELP = 'Pairing did not finish. The board draws a 6-digit PIN on its screen (about 20 s). Type it in the Android pairing box, then try again. The PIN changes every 3 minutes.';
  class BoardError extends Error {
    constructor(verb, code) { super(BOARD_ERRORS[code] || verb + ' failed: ' + code); this.code = code; }
  }
  // Real board over Web Bluetooth. Stage B1 firmware has only status; stage B2 adds the command and data
  // characteristics: text commands, one at a time, answered by notify; bulk answers come as
  // "<verb> begin", data notifies, "<verb> end <bytes> <crc32>". Writes need a link encrypted with a PIN:
  // the first command makes Android ask to pair and the board draws a 6-digit PIN (design D7, stage B2b).
  class RealBoard {
    constructor(bt) {
      this.kind = 'real'; this.bt = bt || navigator.bluetooth; this.device = null; this.chars = {};
      this.lines = []; this.waiters = []; this.bulk = null; this.chain = Promise.resolve();
    }
    async connect() {
      this.device = await this.bt.requestDevice({ filters: [{ services: [UUID.service] }], optionalServices: [UUID.service] });
      this.device.addEventListener('gattserverdisconnected', () => { this.fail(new Error('lost')); onLost(); });
      const server = await this.device.gatt.connect();
      this.service = await server.getPrimaryService(UUID.service);
      this.chars.status = await this.service.getCharacteristic(UUID.status);
      try {
        this.chars.command = await this.service.getCharacteristic(UUID.command);
        this.chars.data = await this.service.getCharacteristic(UUID.data);
      } catch (e) { this.chars.command = null; return; } // Stage B1 firmware.
      this.chars.command.addEventListener('characteristicvaluechanged', e => this.onLine(new TextDecoder().decode(e.target.value)));
      this.chars.data.addEventListener('characteristicvaluechanged', e => {
        const v = e.target.value;
        if (this.bulk) this.bulk.parts.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
      });
      await this.chars.command.startNotifications();
      await this.chars.data.startNotifications();
    }
    onLine(line) {
      const verb = line.split(' ')[0];
      const i = this.waiters.findIndex(w => w.verb === verb);
      if (i < 0) { this.lines.push(line); return; }
      const w = this.waiters.splice(i, 1)[0];
      clearTimeout(w.timer); w.resolve(line);
    }
    expect(verb, ms) {
      const i = this.lines.findIndex(l => l.split(' ')[0] === verb);
      if (i >= 0) return Promise.resolve(this.lines.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { verb, resolve, reject };
        w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('No answer from the board (' + verb + ').')); }, ms);
        this.waiters.push(w);
      });
    }
    fail(err) { this.waiters.splice(0).forEach(w => { clearTimeout(w.timer); w.reject(err); }); this.lines = []; this.bulk = null; }
    // A write that failed gets no answer: drop its waiter, or it would take the next command's answer.
    forget(verb) { const i = this.waiters.findIndex(w => w.verb === verb); if (i >= 0) { clearTimeout(this.waiters[i].timer); this.waiters.splice(i, 1); } }
    async send(verb, text) { try { await this.write(text); } catch (e) { this.forget(verb); this.bulk = null; throw e; } }
    serial(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
    need() { if (!this.chars.command) throw new NeedsFirmware('B2'); }
    async write(text) {
      try { await this.chars.command.writeValueWithResponse(new TextEncoder().encode(text)); }
      catch (e) {
        // [ASSUMPTION] Chrome reports a pairing that failed or ran out as a GATT error on a link still up.
        if (this.device && this.device.gatt.connected && (e.name === 'NetworkError' || e.name === 'SecurityError')) throw new Error(PAIR_HELP + ' (' + e.message + ')');
        throw e;
      }
    }
    command(text, ms = 10000) {
      return this.serial(async () => {
        this.need();
        const verb = text.split(' ')[0], answer = this.expect(verb, ms);
        await this.send(verb, text);
        const parts = (await answer).split(' ');
        if (parts[1] === 'err') throw new BoardError(verb, parts[2]);
        return parts.slice(2);
      });
    }
    fetch(text, ms) {
      return this.serial(async () => {
        this.need();
        const verb = text.split(' ')[0];
        this.bulk = { parts: [] };
        const first = this.expect(verb, 10000);
        await this.send(verb, text);
        const head = (await first).split(' ');
        if (head[1] === 'err') { this.bulk = null; throw new BoardError(verb, head[2]); }
        const end = (await this.expect(verb, ms)).split(' ');
        const parts = this.bulk.parts; this.bulk = null;
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0; parts.forEach(p => { out.set(p, at); at += p.length; });
        if (end[1] !== 'end' || +end[2] !== out.length || parseInt(end[3], 16) !== C.crc32(out)) throw new Error('The ' + verb + ' answer arrived damaged. Try again.');
        return out;
      });
    }
    async status() { return JSON.parse(new TextDecoder().decode(await this.chars.status.readValue())); }
    async signIn(user, password) {
      try { await this.command('login ' + user + ' ' + password); return true; } catch (e) { if (e.code === 'bad_login') return false; throw e; }
    }
    async images() {
      const lines = new TextDecoder().decode(await this.fetch('list', 30000)).split('\n');
      return { current: lines[0], names: lines.slice(1).filter(Boolean) };
    }
    async thumb(name) { return C.unpack2bpp(await this.fetch('thumb ' + name, 20000), THUMB, THUMB); }
    async showImage(name) { await this.command('show ' + name); }
    async deleteImages(names) { for (const n of names) await this.command('delete ' + n); }
    async upload(name, bytes, idx, onProgress, signal) {
      await this.serial(async () => {
        this.need();
        let answer = this.expect('upload_begin', 10000);
        await this.send('upload_begin', 'upload_begin ' + name + ' ' + bytes.length);
        let parts = (await answer).split(' ');
        if (parts[1] === 'err') throw new BoardError('upload_begin', parts[2]);
        const chunk = Math.max(20, +parts[2] || 20);
        for (let at = 0; at < bytes.length; at += chunk) {
          if (signal.lost) throw new Error('lost');
          await this.chars.data.writeValueWithoutResponse(bytes.subarray(at, at + chunk));
          onProgress(Math.min(1, (at + chunk) / bytes.length), Math.min(bytes.length, at + chunk));
        }
        answer = this.expect('upload_end', 30000);
        await this.send('upload_end', 'upload_end ' + C.crc32(bytes).toString(16).padStart(8, '0'));
        parts = (await answer).split(' ');
        if (parts[1] === 'err') throw new BoardError('upload_end', parts[2]);
      });
    }
    async history(from) {
      const text = new TextDecoder().decode(await this.fetch('history ' + Math.max(0, Math.floor(from)), 180000));
      return { text, files: null };
    }
    // Stage B5 (T-024). Names and passwords go as hex of their UTF-8 bytes, so spaces survive.
    async wifiInfo() {
      if (!this.chars.command) return { ssid: null };
      try { return JSON.parse(new TextDecoder().decode(await this.fetch('wifi', 10000))); }
      catch (e) { if (e.code === 'unknown') return { ssid: null }; throw e; }
    }
    async joinWifi(ssid, password) {
      try {
        const parts = await this.command('wifi_join ' + hex(ssid) + ' ' + hex(password), 60000);
        return { ok: true, ip: parts[0] };
      } catch (e) {
        if (e.code === 'unknown') throw new NeedsFirmware('B5');
        if (e.code === 'failed' || e.code === 'timeout') return { ok: false, reason: e.code === 'failed' ? 'wrong password, or the network is out of reach.' : 'no answer in 45 s.' };
        throw e;
      }
    }
    async changeLogin(user, password) {
      try { await this.command('set_login ' + hex(user) + ' ' + hex(password)); }
      catch (e) { if (e.code === 'unknown') throw new NeedsFirmware('B5'); throw e; }
    }
    disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }
  }
  function hex(text) { return Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join(''); }

  // Demo pictures, drawn here and dithered by epd-core like a real upload.
  function scene(kind) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const grad = (a, b, y0 = 0, y1 = H) => { const s = g.createLinearGradient(0, y0, 0, y1); s.addColorStop(0, a); s.addColorStop(1, b); return s; };
    const circle = (x, y, r, f) => { g.fillStyle = f; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
    const poly = (f, pts) => { g.fillStyle = f; g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.fill(); };
    if (kind === 'mountains') {
      g.fillStyle = grad('#9cc8ef', '#f4e7c4'); g.fillRect(0, 0, W, H); circle(150, 50, 22, '#ffd400');
      poly('#3a3a40', [0, 170, 60, 70, 110, 150, 150, 90, 200, 160, 200, 200, 0, 200]);
      poly('#ffffff', [48, 92, 60, 70, 72, 92, 66, 88, 60, 96, 54, 88]); poly('#ffffff', [140, 106, 150, 90, 160, 106]);
      g.fillStyle = '#b52a2a'; g.fillRect(0, 185, W, 15);
    } else if (kind === 'sunset') {
      g.fillStyle = grad('#4a90d9', '#f08a4b'); g.fillRect(0, 0, W, H); circle(140, 75, 30, '#ffd400');
      g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(0, 150); g.quadraticCurveTo(60, 100, 130, 150); g.lineTo(0, 200); g.fill();
      g.fillStyle = '#2d2d2d'; g.beginPath(); g.moveTo(60, 200); g.quadraticCurveTo(140, 125, 200, 165); g.lineTo(200, 200); g.fill();
    } else if (kind === 'cat') {
      g.fillStyle = '#ffd84a'; g.fillRect(0, 0, W, H); circle(100, 125, 52, '#222'); circle(100, 72, 34, '#222');
      poly('#222', [70, 60, 74, 22, 96, 48]); poly('#222', [130, 60, 126, 22, 104, 48]);
      circle(88, 70, 6, '#ffffff'); circle(112, 70, 6, '#ffffff'); g.fillStyle = '#d33'; g.fillRect(70, 100, 60, 8);
    } else if (kind === 'bird') {
      g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, W, H); g.fillStyle = '#4a3b2a'; g.fillRect(0, 150, W, 8);
      circle(100, 110, 42, '#d42a2a'); circle(130, 80, 24, '#d42a2a'); poly('#ffb300', [150, 76, 176, 84, 150, 92]);
      circle(136, 74, 4, '#111'); poly('#222', [58, 100, 20, 130, 66, 128]);
    } else if (kind === 'lake') {
      g.fillStyle = grad('#cfe3f5', '#ffffff', 0, 100); g.fillRect(0, 0, W, 100); g.fillStyle = grad('#3a6ea5', '#16324f', 100, 200); g.fillRect(0, 100, W, 100);
      poly('#1f2d22', [0, 100, 30, 60, 60, 100]); poly('#1f2d22', [40, 100, 70, 50, 100, 100]); poly('#1f2d22', [140, 100, 170, 64, 200, 100]);
      circle(60, 36, 14, '#ffe14a'); g.fillStyle = '#ffffff'; for (let i = 0; i < 6; i++) g.fillRect(20 + i * 30, 130 + (i % 3) * 18, 18, 2);
    } else {
      g.fillStyle = '#0d0f1a'; g.fillRect(0, 0, W, H); circle(160, 36, 14, '#f5f0d0');
      [[10, 90, 40, 110], [55, 60, 40, 140], [100, 110, 35, 90], [140, 80, 50, 120]].forEach(([x, y, w, h]) => {
        g.fillStyle = '#26262e'; g.fillRect(x, y, w, h); g.fillStyle = '#ffd400';
        for (let yy = y + 8; yy < 190; yy += 14) for (let xx = x + 6; xx < x + w - 6; xx += 10) if ((xx * 7 + yy * 3) % 5) g.fillRect(xx, yy, 4, 6);
      });
      g.fillStyle = '#c62828'; g.fillRect(0, 190, W, 10);
    }
    return C.quantize(g.getImageData(0, 0, W, H).data, W, H, { dither: 'floyd', serpentine: true, metric: 'redmean', palette: C.PURE_RGB });
  }
  function downsample(idx) {
    const out = new Uint8Array(THUMB * THUMB), k = W / THUMB;
    for (let y = 0; y < THUMB; y++) for (let x = 0; x < THUMB; x++) out[y * THUMB + x] = idx[(y * k) * W + x * k];
    return out;
  }
  // The board's own BMP rule (image_store_decode_bmp): checks, then maps each pixel to an ink.
  function readBmp(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4D) return { error: 'not a BMP file' };
    const offset = dv.getUint32(10, true), width = dv.getInt32(18, true), height = dv.getInt32(22, true);
    const bits = dv.getUint16(28, true), comp = dv.getUint32(30, true);
    if (bits !== 24 || comp !== 0) return { error: bits + '-bit' + (comp ? ' compressed' : '') + ' BMP; the board reads 24-bit only' };
    if (width !== W || Math.abs(height) !== H) return { error: width + ' × ' + Math.abs(height) + ' px; the board needs 200 × 200' };
    const stride = (W * 3 + 3) & ~3;
    if (offset > bytes.length || bytes.length - offset < stride * H) return { error: 'the file is cut short' };
    const idx = new Uint8Array(W * H);
    let other = 0;
    for (let y = 0; y < H; y++) {
      const row = offset + stride * (height > 0 ? H - 1 - y : y);
      for (let x = 0; x < W; x++) {
        const b = bytes[row + x * 3], g = bytes[row + x * 3 + 1], r = bytes[row + x * 3 + 2];
        let c = 1;
        if (b < 128 && g < 128 && r < 128) c = 0;
        else if (b < 128 && g > 127 && r > 127) c = 2;
        else if (b < 128 && g < 128 && r > 127) c = 3;
        const pure = C.PURE_RGB[c];
        if (pure[0] !== r || pure[1] !== g || pure[2] !== b) other++;
        idx[y * W + x] = c;
      }
    }
    return { idx, other };
  }

  // Example data, clearly a demo: values in the range the board reported on 11-12/11.
  class DemoBoard {
    constructor() {
      this.kind = 'demo'; this.t0 = Date.now(); this.mv = 3812;
      // No login in the source: the first name and password used become the demo login.
      this.login = null;
      this.wifi = { ssid: 'Demo network', ip: '192.0.2.3' };
      this.pics = new Map([['01_mountains.bmp', 'mountains'], ['02_sunset.bmp', 'sunset'], ['03_cat.bmp', 'cat'],
        ['04_red_bird.bmp', 'bird'], ['05_lake.bmp', 'lake'], ['06_city_night.bmp', 'city']].map(([n, k]) => [n, scene(k)]));
      this.current = '02_sunset.bmp';
    }
    async connect() { await wait(600); }
    async status() {
      await wait(100);
      this.mv = Math.max(3500, this.mv - 1);
      const t = (Date.now() - this.t0) / 60000;
      return {
        api: 1, version: 'v1.1.0-t20', partition: 'ota_0', ip: this.wifi.ip, battery_percent: Math.round((this.mv - 3500) / 6.5),
        battery_mv: this.mv, temp_c: Math.round((23.1 + Math.sin(t) * 0.3) * 10) / 10, humidity: Math.round((64.9 + Math.cos(t) * 0.8) * 10) / 10,
        uptime_ms: 5180316 + (Date.now() - this.t0), free_heap: 8504487, confirmed: true
      };
    }
    async signIn(user, password) {
      await wait(250);
      if (!this.login && user && password) this.login = { user, password };
      return !!this.login && user === this.login.user && password === this.login.password;
    }
    async images() { await wait(150); return { names: Array.from(this.pics.keys()).sort(), current: this.current }; }
    // [ASSUMPTION] Stage B2 adds "thumb <name>": 100 x 100 at 2 bits per pixel, 2500 B per picture.
    async thumb(name) { await wait(60); const idx = this.pics.get(name); return idx ? downsample(idx) : null; }
    async showImage(name) { await wait(250); this.current = name; }
    async deleteImages(names) {
      await wait(250);
      names.forEach(n => this.pics.delete(n));
      if (!this.pics.has(this.current)) this.current = Array.from(this.pics.keys()).sort()[0] || '';
    }
    async upload(name, bytes, idx, onProgress, signal) {
      // [ASSUMPTION] 30 KB/s: middle of the 20-60 KB/s estimate in design §4, not measured.
      const rate = 30000, step = 40;
      for (let sent = 0; sent < bytes.length;) {
        if (signal.lost) throw new Error('lost');
        sent = Math.min(bytes.length, sent + Math.round(rate * step / 1000));
        onProgress(sent / bytes.length, sent);
        await wait(step);
      }
      this.pics.set(name, idx);
      this.current = name;
    }
    async wifiInfo() { await wait(80); return { ssid: this.wifi.ssid, ip: this.wifi.ip }; }
    // [ASSUMPTION] Stage B2 adds "history <from_unix>": the log lines from that time on, as /api/history sends them.
    async history(from) {
      if (!demoLog) demoLog = makeDemoLog();
      const lines = demoLog.text.split('\n');
      const keep = [lines[0]].concat(lines.slice(1).filter(l => { const t = +l.split(',')[1]; return !from || !(t < from); }));
      await wait(250);
      return { text: keep.join('\n'), files: demoLog.files };
    }
    async joinWifi(ssid) {
      await wait(2500); // The board tries the new network for up to 20 s; shortened for the demo.
      if (/5g/i.test(ssid)) return { ok: false, reason: 'network not found. Is it a 5 GHz network?' };
      this.wifi = { ssid, ip: '192.0.2.24' };
      return { ok: true, ip: this.wifi.ip };
    }
    async changeLogin(user, password) { await wait(300); this.login = { user, password }; }
    disconnect() { onLost(); }
  }

  // ---------- connection ----------
  let board = null, statusTimer = 0, lastRead = 0, sending = null, lastStatus = null;
  function setState(st, title, sub) {
    $('pill').dataset.state = st;
    $('conn').dataset.state = st;
    $('pillText').textContent = { idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', demo: 'Demo board', lost: 'Disconnected' }[st];
    $('connTitle').textContent = title;
    $('connSub').textContent = sub;
    const on = st === 'connected' || st === 'demo';
    $('connectBtn').textContent = on ? 'Disconnect' : st === 'lost' ? 'Reconnect' : 'Connect';
    $('connectBtn').className = on ? 'btn' : 'btn primary';
    $('connectBtn').disabled = st === 'connecting' || (PREVIEW && !on);
    $('demoBtn').hidden = on;
    $('connBtns').className = on ? 'btns one' : 'btns';
    $('connHelp').hidden = on;
    $('view-home').classList.toggle('on', on);
    updateSend();
  }
  function webBluetoothReason() {
    if (PREVIEW) return 'Bluetooth is blocked inside this preview.';
    if (!window.isSecureContext) return 'Bluetooth needs an https:// address or localhost.';
    if (!navigator.bluetooth) return 'This browser has no Web Bluetooth. Use Chrome on Android.';
    return '';
  }
  async function connectReal() {
    const why = webBluetoothReason();
    if (why) { toast(why); return; }
    setState('connecting', 'Looking for eddie-device…', 'Pick eddie-device in the list Chrome shows.');
    const b = new RealBoard();
    try { await b.connect(); } catch (e) {
      setState('idle', 'Not connected', e && e.name === 'NotFoundError' ? 'No board picked. Is it on USB, or in maintenance (hold BOOT 2 s)?' : 'Could not connect: ' + (e && e.message || e));
      return;
    }
    board = b;
    setState('connected', 'eddie-device', 'Connected over Bluetooth');
    startStatus();
  }
  async function connectDemo() {
    setState('connecting', 'Starting the demo board…', 'No Bluetooth used.');
    board = new DemoBoard();
    await board.connect();
    setState('demo', 'Demo board', 'Example data, nothing leaves this page');
    startStatus();
    if (view === 'images') renderImages();
    if (view === 'settings') renderSettings();
    if (view === 'history') loadHistory();
  }
  function startStatus() { readStatus(); clearInterval(statusTimer); statusTimer = setInterval(readStatus, STATUS_PERIOD_MS); }
  function onLost() {
    clearInterval(statusTimer);
    if (sending) sending.lost = true;
    const wasDemo = board && board.kind === 'demo';
    board = null; auth = null; thumbs.clear();
    setState(wasDemo ? 'idle' : 'lost', wasDemo ? 'Not connected' : 'Disconnected', wasDemo ? 'Demo board closed' : 'The board left. Tap Reconnect when it is in reach.');
    if (view === 'images') renderImages();
    if (view === 'settings') renderSettings();
    if (view === 'history') loadHistory();
  }
  $('connectBtn').onclick = () => { if (board) board.disconnect(); else connectReal(); };
  $('demoBtn').onclick = connectDemo;

  async function readStatus() {
    if (!board) return;
    try { const s = await board.status(); lastRead = Date.now(); lastStatus = s; paintStatus(s); }
    catch (e) { toast('Status read failed: ' + (e && e.message || e)); }
  }
  function paintStatus(s) {
    $('rTemp').innerHTML = (s.temp_c == null ? '–' : s.temp_c.toFixed(1)) + '<small>°C</small>';
    $('rHum').innerHTML = (s.humidity == null ? '–' : Math.round(s.humidity)) + '<small>%</small>';
    const pct = s.battery_percent, mv = s.battery_mv;
    $('dBat').textContent = (pct == null ? '–' : pct + ' %') + ' · ' + (mv == null || mv < 0 ? '–' : mv.toLocaleString('en-US')) + ' mV';
    paintCells(pct);
    $('dVer').textContent = (s.version || '–') + ' · ' + (s.partition || '–') + (s.confirmed === false ? ', on trial' : ', confirmed');
    $('dIp').textContent = s.ip ? s.ip : 'off (on battery the board keeps Wi-Fi off)';
    $('dUp').textContent = uptime(s.uptime_ms);
    $('rawJson').textContent = JSON.stringify(s, null, 1);
  }
  function paintCells(pct) {
    const cells = $('dBatCells'); cells.innerHTML = '';
    for (let i = 0; i < 10; i++) { const c = document.createElement('i'); if (pct != null && i < Math.round(pct / 10)) c.className = 'on'; cells.appendChild(c); }
    cells.classList.toggle('low', pct != null && pct < 30);
  }
  function uptime(ms) {
    if (!(ms >= 0)) return '–';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? d + ' d ' + (h % 24) + ' h' : h ? h + ' h ' + (m % 60) + ' min' : m + ' min';
  }
  setInterval(() => {
    if (board && lastRead) {
      const s = Math.round((Date.now() - lastRead) / 1000);
      $('connSub').textContent = (board.kind === 'demo' ? 'Example data' : 'Connected over Bluetooth') + ' · read ' + s + ' s ago';
    }
    if (auth && Date.now() > auth.until) { auth = null; if (view === 'settings') renderSettings(); }
    if (auth && view === 'settings') renderAuth();
  }, 1000);

  // ---------- sign-in ----------
  let auth = null; // { user, until }
  function signedIn() { return !!auth && Date.now() < auth.until; }
  function needSignIn(why) {
    if (signedIn()) return Promise.resolve(true);
    if (!board) { toast('Connect to the board first.'); return Promise.resolve(false); }
    return new Promise(resolve => {
      $('signWhy').textContent = why;
      setResult('signResult', '', '');
      $('su').value = auth ? auth.user : ''; $('sp').value = '';
      $('signScrim').hidden = false; $('su').focus();
      const close = v => { $('signScrim').hidden = true; $('signForm').onsubmit = $('signNo').onclick = null; resolve(v); };
      $('signNo').onclick = () => close(false);
      $('signForm').onsubmit = async e => {
        e.preventDefault();
        setResult('signResult', 'busy', 'Checking…');
        let ok;
        try { ok = await board.signIn($('su').value, $('sp').value); } catch (err) { setResult('signResult', 'err', err.message); return; }
        if (!ok) { setResult('signResult', 'err', 'Wrong user name or password.'); $('sp').select(); return; }
        auth = { user: $('su').value, until: Date.now() + SESSION_MS };
        close(true);
        toast('Signed in as ' + auth.user + ' for 20 minutes');
        if (view === 'settings') renderSettings();
      };
    });
  }

  // ---------- images ----------
  let selecting = false;
  const selected = new Set(), thumbs = new Map();
  const IMG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="m21 15-5-5L5 21"></path></svg>';
  const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>';
  function paintIdx(canvas, idx, size) {
    canvas.width = size; canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(C.indicesToRGBA(idx, size, size, C.PURE_RGB), size, size), 0, 0);
  }
  async function renderImages() {
    const area = $('imgArea');
    const on = !!board;
    $('selectBtn').hidden = !on; $('imgActions').hidden = !on; $('layoutSeg').hidden = !on;
    if (!on) {
      selecting = false; selected.clear(); $('delBar').hidden = true;
      $('imgCount').textContent = 'Not connected';
      area.innerHTML = '<div class="card empty">' + IMG_ICON + '<p>Connect to the board to see the pictures on its SD card.</p><button class="btn primary" type="button" id="goHome">Connect</button></div>';
      $('goHome').onclick = () => go('home');
      return;
    }
    let data;
    try { data = await board.images(); } catch (e) {
      $('imgCount').textContent = 'Not available yet'; $('selectBtn').hidden = true;
      area.innerHTML = '<div class="card empty">' + IMG_ICON + '<p>' + escapeHtml(e.message) + '</p></div>';
      return;
    }
    $('imgCount').textContent = data.names.length + (data.names.length === 1 ? ' picture' : ' pictures') + (board.kind === 'demo' ? ' · demo' : '');
    if (!data.names.length) { area.innerHTML = '<div class="card empty">' + IMG_ICON + '<p>The card has no pictures yet. Upload a .bmp or make one from a photo.</p></div>'; updateDel(); return; }
    if (layout === 'list') { area.innerHTML = ''; area.appendChild(listView(data)); updateDel(); return; }
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const n of data.names) {
      const tile = document.createElement('div');
      tile.className = 'thumb';
      if (selecting) tile.setAttribute('aria-checked', selected.has(n) ? 'true' : 'false');
      tile.innerHTML = '<button type="button" class="pic"><canvas width="100" height="100"></canvas>' +
        (n === data.current ? '<em class="badge">On display</em>' : '') + (selecting ? '<i class="tick" aria-hidden="true"></i>' : '') +
        '</button>' + (selecting ? '' : '<button type="button" class="del">' + TRASH + '</button>') + '<div class="name"></div>';
      tile.querySelector('.name').textContent = n;
      tile.querySelector('.pic').setAttribute('aria-label', (selecting ? 'Select ' : 'Show on display: ') + n);
      tile.querySelector('.pic').onclick = () => onPicTap(n, tile);
      const del = tile.querySelector('.del');
      if (del) { del.setAttribute('aria-label', 'Delete ' + n); del.onclick = () => deleteNames([n]); }
      grid.appendChild(tile);
      loadThumb(n, tile.querySelector('canvas'));
    }
    area.innerHTML = '';
    area.appendChild(grid);
    updateDel();
  }
  // List: names only, no thumbnails read from the board (faster with many pictures).
  function listView(data) {
    const list = document.createElement('div');
    list.className = 'list';
    for (const n of data.names) {
      const line = document.createElement('div');
      line.className = 'line';
      if (selecting) line.setAttribute('aria-checked', selected.has(n) ? 'true' : 'false');
      line.innerHTML = '<button type="button" class="pick">' + (selecting ? '<i aria-hidden="true"></i>' : '') + '<span></span>' +
        (n === data.current ? '<em>On display</em>' : '') + '</button>' + (selecting ? '' : '<button type="button" class="icon-btn">' + TRASH + '</button>');
      line.querySelector('span').textContent = n;
      line.querySelector('.pick').setAttribute('aria-label', (selecting ? 'Select ' : 'Show on display: ') + n);
      line.querySelector('.pick').onclick = () => onPicTap(n, line);
      const del = line.querySelector('.icon-btn');
      if (del) { del.setAttribute('aria-label', 'Delete ' + n); del.onclick = () => deleteNames([n]); }
      list.appendChild(line);
    }
    return list;
  }
  let layout = load('eddie.imgLayout', 'grid') === 'list' ? 'list' : 'grid';
  function paintLayout() { $('layoutSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.l === layout ? 'true' : 'false')); }
  $('layoutSeg').querySelectorAll('button').forEach(b => { b.onclick = () => { layout = b.dataset.l; save('eddie.imgLayout', layout); paintLayout(); renderImages(); }; });
  paintLayout();

  async function loadThumb(name, canvas) {
    let idx = thumbs.get(name);
    if (!idx) { try { idx = await board.thumb(name); } catch (e) { idx = null; } if (idx) thumbs.set(name, idx); }
    if (idx) paintIdx(canvas, idx, THUMB);
  }
  async function onPicTap(name, tile) {
    if (selecting) {
      if (selected.has(name)) selected.delete(name); else selected.add(name);
      tile.setAttribute('aria-checked', selected.has(name) ? 'true' : 'false');
      updateDel();
      return;
    }
    try { await board.showImage(name); toast('Showing ' + name + '. The panel needs about 20 s.'); renderImages(); }
    catch (e) { toast(e.message); }
  }
  function updateDel() {
    $('delBar').hidden = !selecting;
    $('delBtn').disabled = selected.size === 0;
    $('delBtn').textContent = selected.size ? 'Delete ' + selected.size + (selected.size === 1 ? ' picture' : ' pictures') : 'Tap pictures to select';
    $('selectBtn').textContent = selecting ? 'Done' : 'Select';
  }
  async function deleteNames(names) {
    if (!(await needSignIn('Deleting pictures needs the board\'s user and password.'))) return;
    const ok = await ask('Delete ' + (names.length === 1 ? names[0] : names.length + ' pictures') + '?',
      (names.length === 1 ? 'It' : names.join(', ')) + ' will be removed from the SD card. This cannot be undone.', 'Delete');
    if (!ok || !board) return;
    try {
      await board.deleteImages(names);
      names.forEach(n => thumbs.delete(n));
      toast('Deleted ' + (names.length === 1 ? names[0] : names.length + ' pictures'));
      selected.clear(); selecting = false; renderImages();
    } catch (e) { if (e.code === 'need_login') auth = null; toast(e.message); }
  }
  $('selectBtn').onclick = () => { selecting = !selecting; selected.clear(); renderImages(); };
  $('delBtn').onclick = () => deleteNames(Array.from(selected));
  $('makeBtn').onclick = () => go('create');

  // Upload a ready .bmp straight to the card.
  $('bmpFile').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setResult('upResult', '', '');
    if (!/\.bmp$/i.test(file.name)) { setResult('upResult', 'err', file.name + ' is not a .bmp. For JPG, PNG or WebP use From a photo.'); return; }
    if (file.size > UPLOAD_MAX) { setResult('upResult', 'err', file.name + ' is ' + Math.round(file.size / 1024) + ' KB; the limit is 130 KB.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bmp = readBmp(bytes);
    if (bmp.error) { setResult('upResult', 'err', file.name + ': ' + bmp.error + '. Nothing was sent. Use From a photo to convert it.'); return; }
    const base = file.name.replace(/\.bmp$/i, ''), safe = C.checkName(base).safe + '.bmp';
    await sendBytes(safe, bytes, bmp.idx, 'upResult', 'upProg', 'upBar',
      bmp.other ? Math.round(100 * bmp.other / (W * H)) + '% of its pixels are not one of the 4 inks and will look white or black. ' : '',
      safe !== file.name ? 'Saved as ' + safe + ' (only A–Z, 0–9, _ and - are allowed). ' : '');
    if (view === 'images') renderImages();
  };

  // Shared by Upload .bmp and Send to display.
  async function sendBytes(name, bytes, idx, resId, progId, barId, warn, renamed) {
    if (!(await needSignIn('Adding pictures needs the board\'s user and password.'))) { setResult(resId, 'err', 'Not sent: sign-in needed.'); return false; }
    const list = await board.images().then(d => d.names).catch(() => null);
    if (list && list.includes(name) && !(await ask('Replace ' + name + '?', 'The card already has a picture with this name. Sending replaces it.', 'Replace'))) return false;
    const started = Date.now();
    sending = { lost: false };
    updateSend();
    $(progId).hidden = false; $(barId).style.width = '0%';
    setResult(resId, 'busy', 'Sending ' + name + '…');
    let ok = false;
    try {
      await board.upload(name, bytes, idx, (f, sent) => {
        $(barId).style.width = (f * 100).toFixed(1) + '%';
        const s = Math.max(0.001, (Date.now() - started) / 1000);
        setResult(resId, 'busy', 'Sending ' + name + ' · ' + Math.round(sent / 1024) + ' / ' + Math.round(bytes.length / 1024) + ' KB · ' + Math.round(sent / 1024 / s) + ' KB/s');
      }, sending);
      thumbs.set(name, downsample(idx));
      setResult(resId, 'ok', (renamed || '') + 'Sent ' + name + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s. The display is refreshing.' + (warn ? ' ' + warn : ''));
      ok = true;
    } catch (e) {
      if (e.code === 'need_login') auth = null;
      setResult(resId, 'err', e instanceof NeedsFirmware ? e.message
        : sending.lost ? 'Connection lost while sending. Nothing was saved on the card.' : 'Not sent: ' + (e && e.message || e));
    }
    sending = null;
    $(progId).hidden = true;
    updateSend();
    return ok;
  }

  // ---------- create: the epd-image pipeline ----------
  const state = { img: null, imgW: 0, imgH: 0, panX: 0, panY: 0, idx: null, adj: null, fit: 'cover', pad: '#ffffff', view: 'result', fileOk: true };
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  function sampleImage() {
    const c = document.createElement('canvas'); c.width = 400; c.height = 400;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 400);
    sky.addColorStop(0, '#4a90d9'); sky.addColorStop(0.6, '#f6d38b'); sky.addColorStop(1, '#f08a4b');
    g.fillStyle = sky; g.fillRect(0, 0, 400, 400);
    g.fillStyle = '#ffd400'; g.beginPath(); g.arc(280, 150, 60, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(0, 300); g.quadraticCurveTo(120, 200, 260, 300); g.lineTo(0, 400); g.fill();
    g.fillStyle = '#2d2d2d'; g.beginPath(); g.moveTo(120, 400); g.quadraticCurveTo(280, 250, 400, 330); g.lineTo(400, 400); g.fill();
    return c;
  }
  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      state.fileOk = false; updateSend();
      setResult('loadResult', 'err', 'Not a picture: ' + file.name + '. Choose a JPG, PNG or WebP.');
      return;
    }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      state.img = im; state.imgW = im.naturalWidth; state.imgH = im.naturalHeight; state.panX = state.panY = 0; state.fileOk = true;
      $('zoom').value = 100; $('zoomOut').textContent = '100%';
      $('name').value = C.checkName(file.name.replace(/\.[^.]+$/, '')).safe.slice(0, 40);
      setResult('loadResult', 'ok', 'Loaded ' + file.name + ' · ' + im.naturalWidth + ' × ' + im.naturalHeight + ' px');
      setResult('sendResult', '', '');
      render(); nameChanged();
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      state.fileOk = false; updateSend();
      setResult('loadResult', 'err', 'Could not open ' + file.name + '. If it is HEIC, share it as JPG first.');
    };
    im.src = url;
  }
  $('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };

  function geometry() {
    const zoom = $('zoom').value / 100;
    const base = state.fit === 'cover' ? Math.max(W / state.imgW, H / state.imgH) : Math.min(W / state.imgW, H / state.imgH);
    const s = base * zoom, dw = state.imgW * s, dh = state.imgH * s;
    if (state.fit === 'cover') {
      const limX = Math.max(0, (dw - W) / 2), limY = Math.max(0, (dh - H) / 2);
      state.panX = Math.max(-limX, Math.min(limX, state.panX));
      state.panY = Math.max(-limY, Math.min(limY, state.panY));
    }
    return { dx: (W - dw) / 2 + state.panX, dy: (H - dh) / 2 + state.panY, dw, dh };
  }
  let pending = false;
  function render() { if (pending) return; pending = true; setTimeout(() => { pending = false; renderNow(); }, 0); }
  function renderNow() {
    if (!state.img) return;
    const g = geometry();
    wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'high';
    wctx.fillStyle = state.pad; wctx.fillRect(0, 0, W, H);
    wctx.drawImage(state.img, g.dx, g.dy, g.dw, g.dh);
    state.adj = C.adjust(wctx.getImageData(0, 0, W, H).data, {
      brightness: +$('brightness').value, contrast: +$('contrast').value, saturation: +$('saturation').value, gamma: $('gamma').value / 100
    });
    state.idx = C.quantize(state.adj, W, H, {
      dither: $('dither').value, strength: $('strength').value / 100, serpentine: $('serp').checked,
      metric: $('metric').value, palette: $('matchPal').value === 'panel' ? C.PANEL_RGB_GUESS : C.PURE_RGB
    });
    paintViewer();
  }
  function paintViewer() {
    const cv = $('viewCanvas'), look = $('panelLook').checked ? C.PANEL_RGB_GUESS : C.PURE_RGB;
    const data = state.view === 'photo' ? state.adj : C.indicesToRGBA(state.idx, W, H, look);
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
    cv.classList.toggle('photo', state.view === 'photo');
    const cnt = C.countColors(state.idx), label = ['Black', 'White', 'Yellow', 'Red'];
    $('share').innerHTML = cnt.map((n, i) => '<div><i style="background:rgb(' + look[i].join(',') + ')"></i>' + label[i] + ' ' + Math.round(100 * n / (W * H)) + '%</div>').join('');
    updateSend();
  }
  [['brightness', v => v], ['contrast', v => v], ['saturation', v => v], ['gamma', v => (v / 100).toFixed(2)],
    ['strength', v => v + '%'], ['zoom', v => v + '%']].forEach(([id, f]) => {
    $(id).addEventListener('input', () => { $(id + 'Out').textContent = f(+$(id).value); render(); });
  });
  ['dither', 'metric', 'matchPal', 'serp'].forEach(id => $(id).addEventListener('change', render));
  const DITHER_NOTE = {
    floyd: 'Spreads each pixel\'s colour error to 4 neighbours. Smooth photos, fine grain.',
    atkinson: 'Spreads only 6/8 of the error, to 6 neighbours. More contrast, cleaner flat areas; dark and bright detail can vanish.',
    bayer4: 'Fixed 4 × 4 threshold pattern. Even cross-hatch texture, coarse.',
    bayer8: 'Fixed 8 × 8 threshold pattern. Finer cross-hatch, more in-between shades.',
    none: 'Each pixel takes the nearest of the 4 inks. Flat areas; best for logos, text and pixel art.'
  };
  $('dither').addEventListener('change', () => { $('ditherNote').textContent = DITHER_NOTE[$('dither').value]; });
  $('panelLook').addEventListener('change', paintViewer);
  $('resetAdj').onclick = () => {
    [['brightness', 0], ['contrast', 0], ['saturation', 30], ['gamma', 100], ['strength', 100]].forEach(([id, v]) => { $(id).value = v; $(id).dispatchEvent(new Event('input')); });
    $('dither').value = 'floyd'; $('metric').value = 'redmean'; $('matchPal').value = 'pure'; $('serp').checked = true; $('panelLook').checked = false; render();
  };
  $('resetCrop').onclick = () => { state.panX = state.panY = 0; $('zoom').value = 100; $('zoomOut').textContent = '100%'; render(); };
  function segment(groupId, attr, onPick) {
    $(groupId).querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        $(groupId).querySelectorAll('button').forEach(o => o.setAttribute('aria-pressed', o === b ? 'true' : 'false'));
        onPick(b.dataset[attr]);
      };
    });
  }
  segment('fitSeg', 'fit', v => { state.fit = v; state.panX = state.panY = 0; $('padField').hidden = v !== 'contain'; render(); });
  segment('viewSeg', 'v', v => { state.view = v; paintViewer(); });
  segment('padInks', 'c', v => { state.pad = v; render(); });

  // Drag to pan, pinch to zoom, on the pinned viewer.
  const vc = $('viewCanvas'), pointers = new Map();
  let drag = null, pinch = null;
  vc.addEventListener('pointerdown', e => {
    vc.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    if (pointers.size === 2) { const [a, b] = Array.from(pointers.values()); pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: +$('zoom').value }; drag = null; }
  });
  vc.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const k = W / vc.getBoundingClientRect().width;
    if (pinch && pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const z = Math.max(100, Math.min(400, Math.round(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
      $('zoom').value = z; $('zoomOut').textContent = z + '%'; render();
    } else if (drag) {
      state.panX = drag.px + (e.clientX - drag.x) * k; state.panY = drag.py + (e.clientY - drag.y) * k; render();
    }
  });
  ['pointerup', 'pointercancel'].forEach(t => vc.addEventListener(t, e => { pointers.delete(e.pointerId); pinch = null; drag = null; }));

  function nameInfo() { return C.exportName($('name').value, $('seq').value); }
  function nameChanged() {
    const info = nameInfo(), parts = [];
    if (info.name.empty) parts.push('Type a name.');
    if (info.name.spaces) parts.push('Spaces become _.');
    if (info.name.bad.length) parts.push('Not allowed: ' + info.name.bad.join(' ') + ' (use A–Z, 0–9, _ and -).');
    if (!info.seq.valid) parts.push('Number: digits only, up to 4.');
    if (info.tooLong) parts.push('Name too long for the card (' + C.MAX_NAME + ' characters).');
    $('nameMsg').hidden = !parts.length; $('nameMsg').textContent = parts.join(' ');
    $('finalName').textContent = info.file + '.bmp';
    updateSend();
  }
  ['name', 'seq'].forEach(id => $(id).addEventListener('input', nameChanged));
  function exportIdx() { const deg = +$('rotate').value; return deg ? C.rotateIndices(state.idx, W, H, deg) : state.idx; }
  function updateSend() {
    if (!state.idx) return;
    const info = nameInfo();
    const blocked = !state.fileOk || !info.seq.valid || info.tooLong || info.name.empty;
    $('sendBtn').disabled = !!sending || blocked;
    $('sendBtn').textContent = sending ? 'Sending…' : board ? 'Send to display' : 'Connect to send';
  }
  $('sendBtn').onclick = async () => {
    if (!board) { go('home'); return; }
    const idx = exportIdx();
    await sendBytes(nameInfo().file + '.bmp', C.toBMP24(idx, W, H), idx, 'sendResult', 'sendProg', 'sendBar', '', '');
  };
  $('saveBtn').hidden = PREVIEW; // The preview frame blocks downloads.
  $('saveBtn').onclick = () => {
    const blob = new Blob([C.toBMP24(exportIdx(), W, H)], { type: 'image/bmp' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nameInfo().file + '.bmp';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------- climate history (the SD card log, history.h) ----------
  // Line: sequence,unix,temp_tenths,humidity,flags,crc32hex — CRC over the text up to the last comma.
  const enc = new TextEncoder();
  function crcHex(text) { return C.crc32(enc.encode(text)).toString(16).padStart(8, '0'); }
  function historyLine(seq, t, tt, h, flags) { const body = seq + ',' + t + ',' + tt + ',' + h + ',' + flags + ','; return body + crcHex(body); }
  // Same checks as the web page /history: skip the header, drop lines with a bad CRC, count sequence gaps,
  // leave out sensor failures (flag 1) and samples taken before the clock was set (unix 0).
  function parseHistory(text) {
    const pts = [];
    let good = 0, bad = 0, gaps = 0, last = 0;
    for (const l of text.split('\n').slice(1)) {
      if (!l) continue;
      const i = l.lastIndexOf(',');
      if (i < 0 || crcHex(l.slice(0, i + 1)) !== l.slice(i + 1).toLowerCase()) { bad++; continue; }
      const [q, t, tt, hh, fl] = l.split(',').map(Number);
      good++; if (last && q !== last + 1) gaps++; last = q;
      if (fl & 1 || !t) continue;
      pts.push([t, tt / 10, hh]);
    }
    return { pts, good, bad, gaps };
  }
  // Demo log: about 13 months, daily and seasonal swing, one 6 h power cut, one sensor failure, one damaged line.
  let demoLog = null;
  function makeDemoLog() {
    const STEP = 900, now = Math.floor(Date.now() / 1000 / STEP) * STEP, start = now - 400 * 86400;
    const lines = ['sequence,unix,temp_tenths,humidity,flags,crc'];
    let seq = 1, r = 12345;
    const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff - 0.5; };
    const cutFrom = now - 3 * 86400 - 6 * 3600, cutTo = cutFrom + 6 * 3600;
    for (let t = start; t <= now; t += STEP) {
      if (t >= cutFrom && t < cutTo) continue; // Board off: no lines, the sequence carries on.
      const d = new Date(t * 1000), hour = d.getHours() + d.getMinutes() / 60, doy = (t - start) / 86400;
      const season = Math.sin(2 * Math.PI * (doy - 80) / 365);
      const temp = 25 + 4 * season + 1.6 * Math.sin(2 * Math.PI * (hour - 9) / 24) + rnd() * 0.4;
      const hum = Math.max(30, Math.min(92, 63 - 9 * season - 6 * Math.sin(2 * Math.PI * (hour - 9) / 24) + rnd() * 3));
      const fail = t === now - 86400 + 7200 ? 1 : 0;
      lines.push(historyLine(seq++, t, fail ? 0 : Math.round(temp * 10), fail ? 0 : Math.round(hum), fail));
    }
    lines.splice(lines.length - 200, 1, lines[lines.length - 200].replace(/,(\d+),(\d+),0,/, ',$1,999,0,')); // Damaged on the card.
    return { text: lines.join('\n') + '\n', files: Math.ceil(seq / 2920), now };
  }

  window.EddieDebug = { demoLogText: () => demoLog && demoLog.text, RealBoard }; // For the check scripts.
  let spanS = +load('eddie.span', '86400');
  if (![86400, 604800, 2592000, 31536000, 0].includes(spanS)) spanS = 86400;
  let hist = null; // { pts, good, bad, gaps, bytes, files }
  const PAD = { l: 34, r: 6, t: 8, b: 22 };
  let plot = null; // shared x geometry of both charts: { x0, x1, n, colsT, colsH, w }
  let cross = -1;

  function paintSpanSeg() { $('spanSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.s === spanS ? 'true' : 'false')); }
  $('spanSeg').querySelectorAll('button').forEach(b => { b.onclick = () => { spanS = +b.dataset.s; save('eddie.span', String(spanS)); paintSpanSeg(); loadHistory(); }; });
  $('historyBtn').onclick = () => go('history');
  $('histBack').onclick = () => go('home');

  async function loadHistory() {
    paintSpanSeg();
    cross = -1; paintReadout();
    if (!board) { hist = null; setResult('histResult', 'err', 'Connect to the board to read its log.'); drawHistory(); return; }
    const from = spanS ? Math.floor(Date.now() / 1000) - spanS : 0;
    setResult('histResult', 'busy', 'Reading the log from the card…');
    document.querySelectorAll('.chart canvas').forEach(c => { c.style.opacity = '.45'; }); // Keep the frame while it reloads.
    try {
      const got = await board.history(from);
      const p = parseHistory(got.text);
      hist = Object.assign(p, { bytes: got.text.length, files: got.files, from });
      setResult('histResult', '', '');
    } catch (e) {
      hist = null;
      setResult('histResult', 'err', e.message);
    }
    document.querySelectorAll('.chart canvas').forEach(c => { c.style.opacity = ''; });
    drawHistory();
  }

  function fmtTime(t, withDate) {
    const d = new Date(t * 1000), p = v => String(v).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes()), dm = p(d.getDate()) + '/' + p(d.getMonth() + 1);
    return withDate === 'year' ? p(d.getMonth() + 1) + '/' + d.getFullYear() : withDate ? dm + ' ' + hm : hm;
  }
  function axisLabel(t) {
    const d = new Date(t * 1000), p = v => String(v).padStart(2, '0');
    if (spanS === 86400) return p(d.getHours()) + ':' + p(d.getMinutes());
    if (spanS === 604800 || spanS === 2592000) return p(d.getDate()) + '/' + p(d.getMonth() + 1);
    return p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2);
  }
  function columns(pts, key, x0, x1, n) {
    const col = new Array(n);
    for (const p of pts) {
      if (p[0] < x0 || p[0] > x1) continue;
      const i = Math.min(n - 1, Math.floor((p[0] - x0) / ((x1 - x0) || 1) * n)), y = p[key];
      const c = col[i] || (col[i] = { lo: y, hi: y, s: 0, k: 0, a: p[0], b: p[0] });
      c.lo = Math.min(c.lo, y); c.hi = Math.max(c.hi, y); c.s += y; c.k++; c.a = Math.min(c.a, p[0]); c.b = Math.max(c.b, p[0]);
    }
    return col;
  }
  function stats(pts, key) {
    let lo = Infinity, hi = -Infinity, s = 0, tLo = 0, tHi = 0;
    for (const p of pts) { const v = p[key]; s += v; if (v < lo) { lo = v; tLo = p[0]; } if (v > hi) { hi = v; tHi = p[0]; } }
    return pts.length ? { lo, hi, avg: s / pts.length, tLo, tHi, last: pts[pts.length - 1][key] } : null;
  }
  function paintStats(id, st, digits) {
    const el = $(id);
    if (!st) { el.innerHTML = ''; return; }
    const f = v => v.toFixed(digits), p = v => String(v).padStart(2, '0');
    const when = t => { const d = new Date(t * 1000); return !spanS || spanS > 2592000 ? p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) : fmtTime(t, spanS !== 86400); };
    el.innerHTML = '<div><dt>Now</dt><dd>' + f(st.last) + '</dd></div>' +
      '<div><dt>Lowest</dt><dd>' + f(st.lo) + ' <small>' + when(st.tLo) + '</small></dd></div>' +
      '<div><dt>Highest</dt><dd>' + f(st.hi) + ' <small>' + when(st.tHi) + '</small></dd></div>' +
      '<div><dt>Average</dt><dd>' + f(st.avg) + '</dd></div>';
  }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawHistory() {
    const pts = hist ? hist.pts.filter(p => !spanS || p[0] >= hist.from) : [];
    const now = Date.now() / 1000;
    const x0 = spanS ? now - spanS : (pts.length ? pts[0][0] : now - 86400), x1 = spanS ? now : (pts.length ? pts[pts.length - 1][0] : now);
    const w = $('chartT').getBoundingClientRect().width || 300, n = Math.max(10, Math.floor(w - PAD.l - PAD.r));
    plot = { x0, x1, n, w, count: pts.length, colsT: columns(pts, 1, x0, x1, n), colsH: columns(pts, 2, x0, x1, n) };
    drawChart('chartT', plot.colsT, '--c-temp', 1, pts.length);
    drawChart('chartH', plot.colsH, '--c-hum', 0, pts.length);
    paintStats('statsT', stats(pts, 1), 1);
    paintStats('statsH', stats(pts, 2), 0);
    paintTable(pts);
    $('histInfo').textContent = hist
      ? hist.good + ' samples read, ' + hist.bad + ' damaged line' + (hist.bad === 1 ? '' : 's') + ' skipped, ' + hist.gaps + ' gap' + (hist.gaps === 1 ? '' : 's') +
        (hist.files == null ? '' : ', ' + hist.files + ' log file' + (hist.files === 1 ? '' : 's')) + '. ' + pts.length + ' shown. Read ' + Math.round(hist.bytes / 1024) + ' KB' +
        (board && board.kind === 'demo' ? ' (demo; about ' + Math.max(1, Math.round(hist.bytes / 30000)) + ' s over Bluetooth at an assumed 30 KB/s).' : '.')
      : '';
  }
  function drawChart(id, cols, colorVar, digits, count) {
    const cv = $(id), dpr = window.devicePixelRatio || 1, w = plot.w, h = 190;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const ink = token('--muted'), grid = token('--line'), color = token(colorVar), fg = token('--fg');
    g.font = '12px ' + token('--font-body');
    if (!count) { g.fillStyle = ink; g.textAlign = 'center'; g.fillText(hist ? 'No samples in this range' : 'No data', w / 2, h / 2); return; }
    let v0 = Infinity, v1 = -Infinity;
    for (const c of cols) if (c) { v0 = Math.min(v0, c.lo); v1 = Math.max(v1, c.hi); }
    // Nice steps: 4 gaps, step 0.5/1/2/5 x 10^k, range always contains the data.
    const raw = Math.max((v1 - v0) / 4, digits ? 0.25 : 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
    const y0 = Math.floor(v0 / step) * step, y1 = Math.max(y0 + step, Math.ceil(v1 / step) * step);
    const ph = h - PAD.t - PAD.b, Y = v => PAD.t + ph - (v - y0) / (y1 - y0) * ph, X = i => PAD.l + i + 0.5;
    g.lineWidth = 1; g.strokeStyle = grid; g.fillStyle = ink; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = y0; v <= y1 + step / 2; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(w - PAD.r, y); g.stroke();
      g.fillText(v.toFixed(step < 1 ? 1 : 0), PAD.l - 6, y);
    }
    // Three time labels: start, middle, end; kept inside the canvas.
    g.textBaseline = 'alphabetic';
    [0, 0.5, 1].forEach(f => {
      const x = PAD.l + (plot.n - 1) * f, s = axisLabel(plot.x0 + (plot.x1 - plot.x0) * f);
      g.textAlign = f === 0 ? 'left' : f === 1 ? 'right' : 'center';
      g.fillText(s, f === 1 ? w - PAD.r : x, h - 6);
    });
    // Band: lowest to highest in each pixel column.
    g.globalAlpha = 0.22; g.fillStyle = color;
    for (let i = 0; i < plot.n; i++) { const c = cols[i]; if (c) g.fillRect(PAD.l + i, Y(c.hi), 1, Math.max(1, Y(c.lo) - Y(c.hi))); }
    g.globalAlpha = 1;
    // Mean line, 2 px, broken where no sample came for an hour (as on the web page).
    const GAP = 3600;
    g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    let prev = null, used = 0;
    for (let i = 0; i < plot.n; i++) {
      const c = cols[i]; if (!c) continue; used++;
      const y = Y(c.s / c.k);
      if (prev && c.a - prev.b <= GAP) g.lineTo(X(i), y); else g.moveTo(X(i), y);
      prev = c;
    }
    g.stroke();
    if (used < plot.n / 4) { g.fillStyle = color; for (let i = 0; i < plot.n; i++) { const c = cols[i]; if (c) { g.beginPath(); g.arc(X(i), Y(c.s / c.k), 4, 0, 7); g.fill(); } } }
    // Crosshair: hairline and a ringed dot at the touched column, on both charts.
    if (cross >= 0 && cols[cross]) {
      const c = cols[cross], x = X(cross), y = Y(c.s / c.k);
      g.strokeStyle = fg; g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(x) + 0.5, PAD.t); g.lineTo(Math.round(x) + 0.5, h - PAD.b); g.stroke();
      g.fillStyle = token('--surface'); g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    }
    cv.dataset.y0 = y0; cv.dataset.y1 = y1; cv.dataset.used = used; // Read back by the check script.
  }
  function nearestColumn(i) {
    if (!plot) return -1;
    for (let d = 0; d < plot.n; d++) { if (plot.colsT[i - d]) return i - d; if (plot.colsT[i + d]) return i + d; }
    return -1;
  }
  function paintReadout() {
    if (!plot || cross < 0 || !plot.colsT[cross]) {
      $('roTime').textContent = 'Touch a graph to read a time'; $('roTemp').textContent = ''; $('roHum').textContent = ''; return;
    }
    const t = plot.colsT[cross], hu = plot.colsH[cross], one = t.k === 1;
    $('roTime').textContent = one ? fmtTime(t.a, true) : fmtTime(t.a, true) + ' – ' + fmtTime(t.b, spanS !== 86400) + ' · ' + t.k + ' samples, average';
    $('roTemp').textContent = (t.s / t.k).toFixed(1) + ' °C';
    $('roHum').textContent = Math.round(hu.s / hu.k) + ' %';
  }
  ['chartT', 'chartH'].forEach(id => {
    const cv = $(id);
    const pick = e => {
      const i = Math.round(e.clientX - cv.getBoundingClientRect().left - PAD.l);
      if (!plot || !plot.count) return;
      cross = nearestColumn(Math.max(0, Math.min(plot.n - 1, i)));
      paintReadout(); drawCharts();
    };
    cv.addEventListener('pointerdown', pick);
    cv.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'mouse') pick(e); });
  });
  function drawCharts() { if (!plot) return; drawChart('chartT', plot.colsT, '--c-temp', 1, plot.count); drawChart('chartH', plot.colsH, '--c-hum', 0, plot.count); }
  // Table view: the same numbers without the graph. Hours for a day, days up to a month, months beyond.
  function paintTable(pts) {
    const unit = spanS === 86400 ? 'hour' : spanS && spanS <= 2592000 ? 'day' : 'month';
    const key = t => { const d = new Date(t * 1000); return unit === 'hour' ? fmtTime(Math.floor(t / 3600) * 3600, true) : unit === 'day' ? String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear() : String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); };
    const rows = new Map();
    for (const p of pts) {
      const k = key(p[0]); let r = rows.get(k);
      if (!r) rows.set(k, r = { tl: Infinity, th: -Infinity, ts: 0, hl: Infinity, hh: -Infinity, hs: 0, n: 0 });
      r.tl = Math.min(r.tl, p[1]); r.th = Math.max(r.th, p[1]); r.ts += p[1]; r.hl = Math.min(r.hl, p[2]); r.hh = Math.max(r.hh, p[2]); r.hs += p[2]; r.n++;
    }
    $('tableSum').textContent = 'Table by ' + unit + ' (' + rows.size + ' rows)';
    const tb = $('histTable');
    tb.innerHTML = '<thead><tr><th>' + unit[0].toUpperCase() + unit.slice(1) + '</th><th>°C low</th><th>°C avg</th><th>°C high</th><th>% low</th><th>% avg</th><th>% high</th></tr></thead>';
    const body = document.createElement('tbody');
    Array.from(rows.entries()).reverse().forEach(([k, r]) => {
      const tr = document.createElement('tr');
      [k, r.tl.toFixed(1), (r.ts / r.n).toFixed(1), r.th.toFixed(1), r.hl, Math.round(r.hs / r.n), r.hh].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
      body.appendChild(tr);
    });
    tb.appendChild(body);
  }
  window.addEventListener('resize', () => { if (view === 'history' && hist) drawHistory(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (view === 'history') drawCharts(); });

  // ---------- settings ----------
  function renderAuth() {
    if (signedIn()) {
      const left = Math.max(0, Math.ceil((auth.until - Date.now()) / 60000));
      $('authTitle').textContent = 'Signed in as ' + auth.user;
      $('authSub').textContent = left + (left === 1 ? ' minute' : ' minutes') + ' left';
      $('authBtn').textContent = 'Sign out';
    } else {
      $('authTitle').textContent = 'Not signed in';
      $('authSub').textContent = 'Needed to add or delete pictures and to change Wi-Fi or the login.';
      $('authBtn').textContent = 'Sign in';
    }
    $('authBtn').disabled = !board;
  }
  async function renderSettings() {
    renderAuth();
    const on = !!board;
    ['joinBtn', 'loginSaveBtn'].forEach(id => { $(id).disabled = !on; });
    if (!on) { $('wNet').textContent = 'not connected'; $('wIp').textContent = '–'; return; }
    const w = await board.wifiInfo().catch(() => ({ ssid: null }));
    $('wNet').textContent = w.ssid || 'not shared by this firmware (stage B5)';
    $('wIp').textContent = (w.ip || (lastStatus && lastStatus.ip)) || 'off';
  }
  $('authBtn').onclick = async () => {
    if (signedIn()) { auth = null; renderAuth(); toast('Signed out'); return; }
    await needSignIn('Sign in to add or delete pictures and to change Wi-Fi or the login.');
    renderAuth();
  };
  document.querySelectorAll('[data-show]').forEach(b => {
    b.onclick = () => { const i = $(b.dataset.show); const hide = i.type === 'text'; i.type = hide ? 'password' : 'text'; b.textContent = hide ? 'Show' : 'Hide'; };
  });
  $('joinBtn').onclick = async () => {
    const ssid = $('ssid').value, pass = $('wpass').value;
    const bytes = new TextEncoder().encode(ssid).length;
    if (!bytes || bytes > 32) { setResult('joinResult', 'err', 'Network name: 1 to 32 characters.'); return; }
    if (pass && (pass.length < 8 || pass.length > 63)) { setResult('joinResult', 'err', 'Wi-Fi password: 8 to 63 characters, or empty for an open network.'); return; }
    if (!(await needSignIn('Changing Wi-Fi needs the board\'s user and password.'))) return;
    $('joinBtn').disabled = true;
    setResult('joinResult', 'busy', 'The board is trying ' + ssid + '…');
    try {
      const r = await board.joinWifi(ssid, pass);
      if (r.ok) { setResult('joinResult', 'ok', 'Joined ' + ssid + ' · address ' + r.ip); $('wpass').value = ''; readStatus(); renderSettings(); }
      else setResult('joinResult', 'err', 'Failed: ' + r.reason + ' The board stays on its old network.');
    } catch (e) { setResult('joinResult', 'err', e.message); }
    $('joinBtn').disabled = !board;
  };
  $('loginSaveBtn').onclick = async () => {
    const u = $('nu').value, p = $('np').value, p2 = $('np2').value;
    if (u.length < 1 || u.length > 32) { setResult('loginResult', 'err', 'User name: 1 to 32 characters. Nothing changed.'); return; }
    if (p.length < 1 || p.length > 64) { setResult('loginResult', 'err', 'Password: 1 to 64 characters. Nothing changed.'); return; }
    if (p !== p2) { setResult('loginResult', 'err', 'The two new passwords differ. Nothing changed.'); return; }
    if (!(await needSignIn('Changing the login needs the current user and password.'))) return;
    try {
      await board.changeLogin(u, p);
      auth = null; ['nu', 'np', 'np2'].forEach(id => { $(id).value = ''; });
      setResult('loginResult', 'ok', 'Login changed to ' + u + '. Sign in again with the new password.');
      renderAuth();
    } catch (e) { setResult('loginResult', 'err', e.message); }
  };

  // ---------- start ----------
  applyTheme(theme);
  $('previewNote').hidden = !PREVIEW;
  paintCells(null);
  const sample = sampleImage();
  state.img = sample; state.imgW = sample.width; state.imgH = sample.height;
  renderNow(); nameChanged();
  setState('idle', 'Not connected', 'Board name: eddie-device');
  show(location.hash.slice(1));
  // Offline after the first visit (sw.js), only in the packed app (build_pwa.py sets EDDIE_PWA): in the
  // source tree a cached copy would hide each edit until the second reload. Needs https:// or localhost.
  if (window.EDDIE_PWA && !PREVIEW && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker not registered:', e.message));
  }
  if (PREVIEW) connectDemo(); // The preview opens on a working demo.
  else if (webBluetoothReason()) $('connHelp').insertAdjacentHTML('beforeend', '<br><span style="color:var(--red)">' + escapeHtml(webBluetoothReason()) + '</span>');
})();
