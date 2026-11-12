/**
 * Verifica se uma alteração no CSS chega ao navegador SEM limpeza manual de cache.
 * Uso: node tools/cache-refresh-test.js
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
const CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const APP_URL = 'http://localhost:3000/';
const PORT = 9335;
const MARKER = '/* cache-refresh-marker */';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const original = fs.readFileSync(CSS_PATH, 'utf8');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cache-'));

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
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

  // 1) Primeira visita: o app abre, o Service Worker instala e faz o cache
  await send('Page.navigate', { url: APP_URL });
  await sleep(3000);
  const swAtivo = await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  })()`);
  console.log(`Service Worker instalado: ${swAtivo}`);

  // 2) O servidor "publica" uma mudança no CSS (simula um novo deploy)
  fs.writeFileSync(CSS_PATH, `${MARKER}\n${original}`, 'utf8');
  console.log('CSS alterado no servidor (marcador inserido).');

  // 3) Recarrega a pagina normalmente (F5) e confere se a versao nova chegou
  await send('Page.reload', { ignoreCache: false });
  await sleep(3000);

  const resultado = await evaluate(`(async () => {
    const css = await fetch('/style.css').then(r => r.text());
    const aplicada = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
    return { marcador: css.includes('${MARKER}'), primaria: aplicada };
  })()`);

  console.log(`CSS novo recebido pelo navegador: ${resultado.marcador}`);
  console.log(`Cor aplicada no DOM: ${resultado.primaria}`);

  const ok = resultado.marcador === true && resultado.primaria === '#218a31';

  // Restaura o arquivo original
  fs.writeFileSync(CSS_PATH, original, 'utf8');

  console.log(ok ? '\nPASS: a atualizacao do CSS chega em um unico F5, sem limpar cache.'
                  : '\nFALHOU: o navegador serviu versao antiga do CSS.');

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
