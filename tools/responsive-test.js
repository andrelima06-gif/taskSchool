/**
 * Verifica a responsividade em várias larguras e tira capturas de tela.
 * Uso: npm run test:responsive
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
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'taskschool-shots');
const PORT = 9334;

const WIDTHS = [320, 360, 390, 414, 600, 768, 1024, 1440];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) {
    console.error('Chrome ou Edge nao encontrado.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-resp-'));
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
  if (!target) throw new Error('Chrome nao respondeu.');

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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  let failures = 0;

  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 768,
    });
    await sleep(600);

    const metrics = await send('Runtime.evaluate', {
      expression: `(() => {
        const d = document.documentElement;
        const overflow = d.scrollWidth - d.clientWidth;
        const scrollable = (el) => {
          let n = el.parentElement;
          while (n && n !== document.body) {
            const ox = getComputedStyle(n).overflowX;
            if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
            n = n.parentElement;
          }
          return false;
        };
        const wide = [...document.querySelectorAll('body *')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.right <= d.clientWidth + 1) return false;
            if (scrollable(el)) return false;
            const ox = getComputedStyle(el).overflowX;
            return ox !== 'auto' && ox !== 'scroll' && ox !== 'hidden';
          })
          .slice(0, 5)
          .map(el => el.tagName + '.' + (el.className || '').toString().split(' ')[0] +
                     ' [right=' + Math.round(el.getBoundingClientRect().right) + ']');
        return {
          scrollWidth: d.scrollWidth,
          clientWidth: d.clientWidth,
          overflow,
          wide
        };
      })()`,
      returnByValue: true,
    });

    const m = metrics.result.value;
    const ok = m.overflow <= 1;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FALHOU'}  ${String(width).padStart(4)}px  scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}` +
      (m.wide.length ? `\n         transbordando: ${m.wide.join(', ')}` : ''));

    const shot = path.join(OUT_DIR, `w${width}.png`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shot, Buffer.from(data, 'base64'));
  }

  console.log(failures === 0 ? '\nTodos os breakpoints estao sem overflow horizontal.' : `\n${failures} breakpoint(s) com overflow.`);
  console.log('Capturas em', OUT_DIR);

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
