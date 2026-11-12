/**
 * Capturas da versão mobile em várias telas (iPhone/Android).
 * Uso: node tools/screenshot-mobile.js
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
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'taskschool-mobile');
const PORT = 9342;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mob-'));
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

  // iPhone 13 (390x844) e Android pequeno (360x780)
  const devices = [
    { name: 'iphone', width: 390, height: 844 },
    { name: 'android', width: 360, height: 780 },
  ];

  const results = [];

  for (const device of devices) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: 1,
      mobile: true,
    });

    await send('Page.navigate', { url: APP_URL });
    await sleep(3000);

    // Cadastro
    let { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${device.name}-1-cadastro.png`), Buffer.from(data, 'base64'));

    // Entra no app
    await evaluate(`(async () => {
      const pill = document.querySelector('.student-pill');
      if (pill) { pill.click(); await new Promise(r => setTimeout(r, 1500)); }
    })()`);
    await sleep(900);

    // Tarefas
    ({ data } = await send('Page.captureScreenshot', { format: 'png' }));
    fs.writeFileSync(path.join(OUT_DIR, `${device.name}-2-tarefas.png`), Buffer.from(data, 'base64'));

    // Nova tarefa (FAB)
    await evaluate(`document.querySelector('#fab').click()`);
    await sleep(700);
    ({ data } = await send('Page.captureScreenshot', { format: 'png' }));
    fs.writeFileSync(path.join(OUT_DIR, `${device.name}-3-nova.png`), Buffer.from(data, 'base64'));

    // Lembretes
    await evaluate(`document.querySelector('.nav-item[data-view="reminders"]').click()`);
    await sleep(700);
    ({ data } = await send('Page.captureScreenshot', { format: 'png' }));
    fs.writeFileSync(path.join(OUT_DIR, `${device.name}-4-lembretes.png`), Buffer.from(data, 'base64'));

    // Aluno
    await evaluate(`document.querySelector('.nav-item[data-view="student"]').click()`);
    await sleep(700);
    ({ data } = await send('Page.captureScreenshot', { format: 'png' }));
    fs.writeFileSync(path.join(OUT_DIR, `${device.name}-5-aluno.png`), Buffer.from(data, 'base64'));

    // Verificações de layout
    const check = await evaluate(`(() => {
      const d = document.documentElement;
      const nav = document.querySelector('.mobile-nav');
      const fab = document.querySelector('.fab');
      const navRect = nav.getBoundingClientRect();
      const fabRect = fab.getBoundingClientRect();
      const navItem = document.querySelector('.nav-item').getBoundingClientRect();
      return {
        overflow: d.scrollWidth - d.clientWidth,
        navVisivel: getComputedStyle(nav).display !== 'none',
        fabVisivel: getComputedStyle(fab).display !== 'none',
        navAltura: Math.round(navRect.height),
        fabTamanho: Math.round(fabRect.width),
        fabAcimaDaNav: fabRect.bottom <= navRect.top + 1,
        alvoToque: Math.round(navItem.height),
        view: document.querySelector('#app').dataset.view
      };
    })()`);

    results.push({ device: device.name, ...check });
    console.log(`${device.name} (${device.width}px):`, JSON.stringify(check));
  }

  console.log('\nCapturas em', OUT_DIR);

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
