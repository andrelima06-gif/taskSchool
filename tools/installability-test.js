/**
 * Verifica se o app atende aos requisitos de instalação do PWA
 * (Chrome: manifest + service worker + ícones + display standalone).
 * Uso: node tools/installability-test.js
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
const PORT = 9337;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) {
    console.error('Chrome ou Edge nao encontrado.');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-install-'));
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
  const events = [];

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) {
      events.push(m.method);
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

  // Captura o evento beforeinstallprompt (prova de instalabilidade no Chrome)
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__installPrompt = null;
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        window.__installPrompt = { platforms: e.platforms, hasPrompt: true };
      });
    `,
  });

  await send('Page.navigate', { url: APP_URL });
  await sleep(4000);

  const manifest = await send('Page.getAppManifest');
  const sw = await send('Runtime.evaluate', {
    expression: `(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const controller = navigator.serviceWorker.controller;
      return {
        registrado: regs.length > 0,
        controlaPagina: !!controller,
        escopo: controller ? controller.scriptURL : null,
        promptInstalacao: window.__installPrompt || null,
        seguro: window.isSecureContext,
        manifesto: document.querySelector('link[rel="manifest"]')?.href || null,
        botaoInstalar: !document.querySelector('#install-btn')?.hidden
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const m = manifest;
  const s = sw.result.value;

  const itens = m.url ? JSON.parse(m.data) : null;
  const erros = m.errors || [];

  console.log('\n=== MANIFESTO ===');
  console.log('URL          :', m.url);
  console.log('Erros        :', erros.length ? erros.map((e) => e.critical ? '[CRITICO] ' + e.message : e.message) : 'nenhum');
  if (itens) {
    console.log('name         :', itens.name);
    console.log('short_name   :', itens.short_name);
    console.log('display      :', itens.display);
    console.log('start_url    :', itens.start_url);
    console.log('theme_color  :', itens.theme_color);
    console.log('background   :', itens.background_color);
    console.log('icones       :', (itens.icons || []).map((i) => `${i.sizes} (${i.purpose || 'any'})`).join(', '));
  }

  console.log('\n=== SERVICE WORKER ===');
  console.log('Registrado   :', s.registrado);
  console.log('Controlando  :', s.controlaPagina, s.escopo || '');
  console.log('Contexto seguro (HTTPS/localhost):', s.seguro);

  console.log('\n=== INSTALABILIDADE ===');
  const temIcone192 = itens && (itens.icons || []).some((i) => i.sizes === '192x192');
  const temIcone512 = itens && (itens.icons || []).some((i) => i.sizes === '512x512');
  const temStart = itens && !!itens.start_url;
  const standalone = itens && ['standalone', 'fullscreen', 'minimal-ui'].includes(itens.display);
  const semErroCritico = !erros.some((e) => e.critical);

  const criterios = [
    ['Manifesto sem erro crítico', semErroCritico],
    ['Tem name/short_name', !!(itens && itens.name && itens.short_name)],
    ['Tem start_url', temStart],
    ['display standalone', !!standalone],
    ['Ícone 192x192', temIcone192],
    ['Ícone 512x512', temIcone512],
    ['Service Worker registrado', s.registrado],
    ['Service Worker controlando a página', s.controlaPagina],
    ['Evento beforeinstallprompt disparado', !!s.promptInstalacao],
    ['Botão "Instalar" visível na interface', s.botaoInstalar === true],
  ];

  criterios.forEach(([nome, ok]) => console.log(`${ok ? 'OK   ' : 'FALHA'}  ${nome}`));

  const instalavel = criterios.slice(0, 8).every(([, ok]) => ok);

  console.log('\n' + (instalavel
    ? 'INSTALAVEL: o app pode ser instalado como PWA (Chrome/Edge).\n  No Android: menu > "Instalar aplicativo". No PC: icone na barra de endereco.\n  No iOS (Safari): Compartilhar > "Adicionar a Tela de Inicio".'
    : 'AINDA NAO INSTALAVEL: verifique os itens marcados como FALHA.'));

  ws.close();
  chrome.kill();
  await sleep(800);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  process.exit(instalavel ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
