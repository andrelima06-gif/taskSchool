/**
 * Captura de tela do fluxo: tela de cadastro e aplicativo logado.
 * Uso: node tools/screenshots.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'taskschool-shots');
const PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* subindo */ }
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('->', file);
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // Tela de cadastro (desktop)
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP_URL });
  await sleep(3000);
  await shot('cadastro-desktop');

  // Tela de cadastro (celular)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(600);
  await shot('cadastro-mobile');

  // Cadastra e entra no app
  await evaluate(`(async () => {
    document.querySelector('#auth-grade').value = '1em';
    document.querySelector('#auth-grade').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    document.querySelector('#auth-class').value = 'DSB';
    document.querySelector('#auth-class').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#auth-name').value = 'Maria Silva';
    document.querySelector('#auth-name').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#auth-form').requestSubmit();
    await new Promise(r => setTimeout(r, 1200));
  })()`);

  await shot('app-mobile');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await shot('app-desktop');

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
