/**
 * Captura da tela com o painel de lembretes.
 * Uso: node tools/screenshot-reminders.js
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
const PORT = 9340;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rem-'));
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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { origin: new URL(APP_URL).origin, permissions: ['notifications'] }).catch(() => {});

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  await evaluate(`(async () => {
    const pill = document.querySelector('.student-pill');
    if (pill) { pill.click(); await new Promise(r => setTimeout(r, 1200)); }
    document.querySelector('#reminder-enabled').checked = true;
    document.querySelector('#reminder-enabled').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    document.querySelector('.reminders-card').scrollIntoView({ block: 'center' });
  })()`);
  await sleep(700);

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, 'lembretes-desktop.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('->', file);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(700);
  await evaluate(`document.querySelector('.reminders-card').scrollIntoView({ block: 'center' })`);
  await sleep(500);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  const file2 = path.join(OUT_DIR, 'lembretes-mobile.png');
  fs.writeFileSync(file2, Buffer.from(shot2.data, 'base64'));
  console.log('->', file2);

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
