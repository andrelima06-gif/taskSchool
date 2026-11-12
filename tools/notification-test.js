/**
 * Testa o sistema de lembretes diários (notificações do PWA).
 * Uso: node tools/notification-test.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('./db');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';
const ORIGIN = new URL(APP_URL).origin;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taskschool.db');
const PORT = 9339;

const TURMA = '7ano-B';
const ALUNO = 'Notific E2E';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanTestData() {
  if (!fs.existsSync(DB_PATH)) return;
  const db = openDb(DB_PATH);
  try {
    const ids = db.prepare("SELECT id FROM students WHERE name LIKE '%E2E%'").all().map((r) => r.id);
    if (ids.length) {
      const delT = db.prepare('DELETE FROM tasks WHERE studentId = ?');
      const delS = db.prepare('DELETE FROM students WHERE id = ?');
      db.transaction(() => ids.forEach((id) => { delT.run(id); delS.run(id); }))();
    }
    db.prepare("DELETE FROM tasks WHERE title LIKE '%NOTIF%'").run();
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

  cleanTestData();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-notif-'));
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // Permite notificações sem prompt (equivalente a o usuário aceitar)
  await send('Browser.grantPermissions', {
    origin: ORIGIN,
    permissions: ['notifications'],
  }).catch(() => {});

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FALHOU'}  ${name}${detail ? ' -> ' + detail : ''}`);
  };

  // Abre o app antes de criar os dados de teste (URLs relativas)
  await send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  // Cria o aluno de teste e as tarefas com prazos varietyados
  const setup = await evaluate(`(async () => {
    const aluno = await fetch('/api/students', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '${ALUNO}', grade: '7ano', className: 'B' })
    }).then(r => r.json());

    const hoje = new Date().toISOString().slice(0, 10);
    const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const criar = (title, dueDate) => fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, subject: 'Teste', dueDate, studentId: aluno.id })
    }).then(r => r.json());

    await criar('NOTIF vencida', ontem);
    await criar('NOTIF para hoje', hoje);
    await criar('NOTIF futura', amanha);

    // Senta a sessao do aluno
    localStorage.setItem('taskschool:session', JSON.stringify({
      id: aluno.id, name: aluno.name, grade: aluno.grade, className: aluno.className,
      classKey: aluno.classKey, classLabel: '7º ano - B'
    }));
    return { id: aluno.id, classKey: aluno.classKey };
  })()`);
  check('Aluno e tarefas de teste criados', !!setup.id, JSON.stringify(setup));

  await send('Page.reload', { ignoreCache: false });
  await sleep(3500);

  // 1. O painel de lembretes existe
  const painel = await evaluate(`({
    existe: !!document.querySelector('.reminders-card'),
    visivel: !document.querySelector('.reminders-card').hidden,
    temSwitch: !!document.querySelector('#reminder-enabled'),
    temHora: !!document.querySelector('#reminder-time'),
    horaPadrao: document.querySelector('#reminder-time').value,
    status: document.querySelector('#reminder-status').textContent,
    appVisivel: !document.querySelector('#app').hidden
  })`);
  check('Painel de lembretes visivel', painel.existe === true && painel.visivel === true);
  check('Interruptor e horario presentes', painel.temSwitch === true && painel.temHora === true);
  check('Horario padrao 18:00', painel.horaPadrao === '18:00', painel.horaPadrao);
  check('Sessao do aluno restaurada', painel.appVisivel === true);

  // 2. Ativar o lembrete
  const ativado = await evaluate(`(async () => {
    document.querySelector('#reminder-enabled').checked = true;
    document.querySelector('#reminder-enabled').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const saved = JSON.parse(localStorage.getItem('taskschool:reminders') || 'null');
    return {
      saved,
      permissao: Notification.permission,
      status: document.querySelector('#reminder-status').textContent,
      campoHoraVisivel: !document.querySelector('#reminder-time-field').hidden
    };
  })()`);
  check('Lembrete salvo nas preferencias', ativado.saved && ativado.saved.enabled === true, JSON.stringify(ativado.saved));
  check('Permissao de notificacao concedida', ativado.permissao === 'granted', ativado.permissao);
  check('Status mostra lembrete ativo', /ativo/i.test(ativado.status), ativado.status);
  check('Campo de horario aparece', ativado.campoHoraVisivel === true);

  // 3. Dispara o aviso e verifica a notificacao do sistema
  const aviso = await evaluate(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const esperar = async () => {
      for (let i = 0; i < 12; i++) {
        const lista = await reg.getNotifications();
        if (lista.length) return lista;
        await new Promise(r => setTimeout(r, 500));
      }
      return [];
    };
    document.querySelector('#reminder-test').click();
    const lista = await esperar();
    return {
      total: lista.length,
      titulo: lista[0] ? lista[0].title : null,
      corpo: lista[0] ? lista[0].body : null,
      tag: lista[0] ? lista[0].tag : null,
      acoes: lista[0] ? lista[0].actions.map(a => a.action) : []
    };
  })()`);
  check('Notificacao do sistema exibida', aviso.total >= 1, `total=${aviso.total}`);
  check('Titulo cita as tarefas para entregar', /tarefa/i.test(aviso.titulo || ''), aviso.titulo);
  check('Corpo lista as tarefas urgentes', /vencida/i.test(aviso.corpo || ''), aviso.corpo);
  check('Tag de notificacao correta', aviso.tag === 'taskschool-daily', aviso.tag);
  check('Acoes de atalho presentes', (aviso.acoes || []).includes('open'), JSON.stringify(aviso.acoes));

  // 4. Horario configuravel
  const horario = await evaluate(`(async () => {
    const input = document.querySelector('#reminder-time');
    input.value = '07:30';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const saved = JSON.parse(localStorage.getItem('taskschool:reminders') || 'null');
    return { saved, status: document.querySelector('#reminder-status').textContent };
  })()`);
  check('Horario alterado e salvo', horario.saved && horario.saved.time === '07:30', JSON.stringify(horario.saved));
  check('Status reflete o novo horario', /07:30/.test(horario.status), horario.status);

  // 5. Sem tarefas urgentes -> aviso de "proxima"
  const semUrgente = await evaluate(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const esperar = async () => {
      for (let i = 0; i < 12; i++) {
        const lista = await reg.getNotifications();
        if (lista.length) return lista;
        await new Promise(r => setTimeout(r, 500));
      }
      return [];
    };
    (await reg.getNotifications()).forEach(n => n.close());
    const lista = await fetch('/api/tasks?classKey=${TURMA}').then(r => r.json());
    const hoje = new Date().toISOString().slice(0, 10);
    for (const t of lista) {
      if (t.dueDate && t.dueDate <= hoje) {
        await fetch('/api/tasks/' + t.id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dueDate: null })
        });
      }
    }
    document.querySelector('#reminder-test').click();
    const nots = await esperar();
    return { titulo: nots[0] ? nots[0].title : null, corpo: nots[0] ? nots[0].body : null };
  })()`);
  check('Sem tarefas urgentes mostra "Nenhuma tarefa para hoje"', /Nenhuma tarefa para hoje/i.test(semUrgente.titulo || ''), semUrgente.titulo);
  check('Corpo cita a proxima tarefa', /Pr[oó]xima/i.test(semUrgente.corpo || ''), semUrgente.corpo);

  // 6. Sem pendencias -> "Tudo em dia!"
  const tudoEmDia = await evaluate(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const esperar = async () => {
      for (let i = 0; i < 12; i++) {
        const lista = await reg.getNotifications();
        if (lista.length) return lista;
        await new Promise(r => setTimeout(r, 500));
      }
      return [];
    };
    (await reg.getNotifications()).forEach(n => n.close());
    const lista = await fetch('/api/tasks?classKey=${TURMA}').then(r => r.json());
    for (const t of lista) {
      await fetch('/api/tasks/' + t.id, { method: 'DELETE' });
    }
    document.querySelector('#reminder-test').click();
    const nots = await esperar();
    return { titulo: nots[0] ? nots[0].title : null };
  })()`);
  check('Sem pendencias mostra "Tudo em dia!"', /Tudo em dia/i.test(tudoEmDia.titulo || ''), tudoEmDia.titulo);

  // 7. Desativar o lembrete
  const desativado = await evaluate(`(async () => {
    document.querySelector('#reminder-enabled').checked = false;
    document.querySelector('#reminder-enabled').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const saved = JSON.parse(localStorage.getItem('taskschool:reminders') || 'null');
    return { saved, status: document.querySelector('#reminder-status').textContent };
  })()`);
  check('Lembrete desativado', desativado.saved && desativado.saved.enabled === false, JSON.stringify(desativado.saved));
  check('Status indica desativado', /desativad/i.test(desativado.status), desativado.status);

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
  console.error('Erro no teste de notificacoes:', error);
  process.exit(1);
});
