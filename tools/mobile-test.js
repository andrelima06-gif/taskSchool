/**
 * Testa a versão mobile: shell de app, navegação inferior, FAB e telas.
 * Uso: node tools/mobile-test.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('./db');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taskschool.db');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';
const PORT = 9343;

const DEVICES = [
  { name: 'iPhone 13', width: 390, height: 844 },
  { name: 'Android pequeno', width: 360, height: 780 },
  { name: 'Tablet', width: 768, height: 1024 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remove as tarefas criadas pelo teste, mantendo o banco como estava. */
function cleanTestData() {
  if (!fs.existsSync(DB_PATH)) return;
  const db = openDb(DB_PATH);
  try {
    db.prepare("DELETE FROM tasks WHERE title LIKE '%mobile E2E%'").run();
  } catch {
    /* ignora */
  } finally {
    db.close();
  }
}

async function main() {
  if (!CHROME) {
    console.error('Chrome ou Edge nao encontrado.');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mob-'));
  cleanTestData();
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
  const consoleErrors = [];

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FALHOU'}  ${name}${detail ? ' -> ' + detail : ''}`);
  };

  for (const device of DEVICES) {
    const isMobile = device.width < 768;
    console.log(`\n--- ${device.name} (${device.width}px) ---`);

    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width, height: device.height, deviceScaleFactor: 1, mobile: isMobile,
    });
    await send('Page.navigate', { url: APP_URL });
    await sleep(3000);

    // Entra no app
    await evaluate(`(async () => {
      const pill = document.querySelector('.student-pill');
      if (pill) { pill.click(); await new Promise(r => setTimeout(r, 1500)); }
    })()`);
    await sleep(700);

    const shell = await evaluate(`(() => {
      const app = document.querySelector('#app');
      const nav = document.querySelector('.mobile-nav');
      const fab = document.querySelector('#fab');
      const navStyle = getComputedStyle(nav);
      const fabStyle = getComputedStyle(fab);
      const d = document.documentElement;
      return {
        mobile: window.innerWidth < 768,
        view: app.dataset.view,
        navVisivel: navStyle.display !== 'none',
        fabVisivel: fabStyle.display !== 'none',
        navFixa: navStyle.position === 'fixed',
        fabFixo: fabStyle.position === 'fixed',
        overflow: d.scrollWidth - d.clientWidth,
        listaVisivel: !!document.querySelector('#list-pending')?.offsetParent,
        formVisivel: !!document.querySelector('#view-new')?.offsetParent,
        alvoToque: Math.round(document.querySelector('.nav-item').getBoundingClientRect().height),
        fabTamanho: Math.round(fab.getBoundingClientRect().width)
      };
    })()`);

    check(`${device.name}: sem overflow horizontal`, shell.overflow <= 1, String(shell.overflow));
    check(`${device.name}: abre na tela de tarefas`, shell.view === 'tasks' && shell.listaVisivel === true, shell.view);
    check(`${device.name}: barra inferior ${isMobile ? 'visivel e fixa' : 'oculta (desktop)'}`,
      isMobile ? (shell.navVisivel && shell.navFixa) : !shell.navVisivel,
      JSON.stringify({ nav: shell.navVisivel, fixa: shell.navFixa }));
    check(`${device.name}: FAB ${isMobile ? 'visivel e fixo' : 'oculto (desktop)'}`,
      isMobile ? (shell.fabVisivel && shell.fabFixo) : !shell.fabVisivel,
      JSON.stringify({ fab: shell.fabVisivel, fixo: shell.fabFixo }));
    check(
      `${device.name}: ${isMobile ? 'formulario escondido na lista' : 'formulario visivel no layout desktop'}`,
      isMobile ? shell.formVisivel === false : shell.formVisivel === true,
      String(shell.formVisivel)
    );

    if (!isMobile) continue;

    // Alvos de toque confortáveis (mínimo 44px)
    check(`${device.name}: alvos de toque >= 44px`, shell.alvoToque >= 44, String(shell.alvoToque));
    check(`${device.name}: FAB com 56px`, shell.fabTamanho === 56, String(shell.fabTamanho));

    // Navegação pela barra inferior
    const nav = await evaluate(`(async () => {
      const resultado = {};
      document.querySelector('.nav-item[data-view="reminders"]').click();
      await new Promise(r => setTimeout(r, 400));
      resultado.lembretes = {
        view: document.querySelector('#app').dataset.view,
        visivel: !!document.querySelector('#view-reminders')?.offsetParent,
        listaOculta: !document.querySelector('.list-section')?.offsetParent,
        ativo: document.querySelector('.nav-item[data-view="reminders"]').classList.contains('is-active')
      };

      document.querySelector('.nav-item[data-view="student"]').click();
      await new Promise(r => setTimeout(r, 400));
      resultado.aluno = {
        view: document.querySelector('#app').dataset.view,
        visivel: !!document.querySelector('#view-student')?.offsetParent,
        nome: document.querySelector('#student-name').textContent,
        avatar: document.querySelector('#student-avatar').textContent
      };

      document.querySelector('#fab').click();
      await new Promise(r => setTimeout(r, 400));
      resultado.nova = {
        view: document.querySelector('#app').dataset.view,
        formVisivel: !!document.querySelector('#view-new')?.offsetParent,
        voltarVisivel: !!document.querySelector('#view-new .mobile-back')?.offsetParent
      };

      // o botao voltar leva para a lista
      document.querySelector('#view-new .mobile-back').click();
      await new Promise(r => setTimeout(r, 400));
      resultado.voltar = {
        view: document.querySelector('#app').dataset.view,
        listaVisivel: !!document.querySelector('#list-pending')?.offsetParent
      };
      return resultado;
    })()`);

    check(`${device.name}: aba Lembretes abre o painel`,
      nav.lembretes.view === 'reminders' && nav.lembretes.visivel && nav.lembretes.ativo,
      JSON.stringify(nav.lembretes));
    check(`${device.name}: aba Aluno mostra o perfil`,
      nav.aluno.view === 'student' && nav.aluno.visivel && nav.aluno.nome.length > 0,
      JSON.stringify(nav.aluno));
    check(`${device.name}: FAB abre o formulario`,
      nav.nova.view === 'new' && nav.nova.formVisivel && nav.nova.voltarVisivel,
      JSON.stringify(nav.nova));
    check(`${device.name}: botao voltar retorna a lista`,
      nav.voltar.view === 'tasks' && nav.voltar.listaVisivel,
      JSON.stringify(nav.voltar));

    // Criar tarefa pelo formulario mobile e voltar para a lista
    const criada = await evaluate(`(async () => {
      const esperar = async (condicao) => {
        for (let i = 0; i < 20; i++) {
          if (condicao()) return true;
          await new Promise(r => setTimeout(r, 400));
        }
        return false;
      };
      document.querySelector('#fab').click();
      await new Promise(r => setTimeout(r, 300));
      const input = document.querySelector('#title');
      input.value = 'Tarefa mobile E2E';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#task-form').requestSubmit();
      const naLista = await esperar(() =>
        [...document.querySelectorAll('.task-title')].some(t => t.textContent.includes('mobile E2E'))
      );
      const voltou = await esperar(() => document.querySelector('#app').dataset.view === 'tasks');
      return { view: document.querySelector('#app').dataset.view, naLista };
    })()`);
    check(`${device.name}: tarefa criada e volta para a lista`,
      criada.naLista === true && criada.view === 'tasks',
      JSON.stringify(criada));
  }

  check('Sem erros de JavaScript no console', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log('\n-----------------------------------------');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} verificacoes passaram`);
  if (failed.length) console.log('FALHAS:', failed.map((f) => f.name).join(', '));

  ws.close();
  chrome.kill();
  await sleep(800);
  cleanTestData();
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Erro no teste mobile:', error);
  process.exit(1);
});
