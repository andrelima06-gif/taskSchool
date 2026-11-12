/**
 * Teste end-to-end do front-end via Chrome DevTools Protocol (sem dependências).
 * Uso: npm run test:e2e
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
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';
const DB_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taskschool.db');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remove os dados criados pelo próprio teste (deixa o banco como estava). */
function cleanTestData() {
  if (!fs.existsSync(DB_PATH)) return;
  const db = openDb(DB_PATH);
  try {
    const ids = db.prepare("SELECT id FROM students WHERE name LIKE '%E2E%'").all().map((r) => r.id);
    if (ids.length) {
      const delTasks = db.prepare('DELETE FROM tasks WHERE studentId = ?');
      const delStudent = db.prepare('DELETE FROM students WHERE id = ?');
      db.transaction(() => ids.forEach((id) => { delTasks.run(id); delStudent.run(id); }))();
    }
    db.prepare("DELETE FROM tasks WHERE title LIKE '%E2E%' OR title LIKE 'Tarefa criada OFFLINE%'").run();
  } catch (error) {
    console.warn('Aviso: nao foi possivel limpar os dados de teste:', error.message);
  } finally {
    db.close();
  }
}

async function main() {
  if (!CHROME) {
    console.error('Chrome ou Edge nao encontrado. Instale o Chrome para rodar os testes.');
    process.exit(1);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
    } catch { /* ainda subindo */ }
  }
  if (!target) throw new Error('Chrome nao respondeu na porta de debug.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || '')
      );
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        'Erro na pagina: ' +
          JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
      );
    }
    return res.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('-> Navegando para', APP_URL);
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  cleanTestData();

  const results = [];

  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FALHOU'}  ${name}${detail ? ' -> ' + detail : ''}`);
  };

  // 1. Estado inicial (aplicativo ainda escondido, aguardando cadastro)
  const initial = await evaluate(`({
    appEscondido: document.querySelector('#app').hidden,
    bannerOffline: !document.querySelector('#offline-banner').hidden,
    botaoCancelar: !document.querySelector('#cancel-edit').hidden
  })`);
  check('Aplicativo escondido antes do cadastro', initial.appEscondido === true);
  check('Banner offline oculto quando online', initial.bannerOffline === false);
  check('Botao "Cancelar edicao" oculto', initial.botaoCancelar === false);

  // 0. Tela de cadastro
  const authScreen = await evaluate(`({
    visivel: !document.querySelector('#auth-screen').hidden,
    appEscondido: document.querySelector('#app').hidden,
    series: [...document.querySelectorAll('#auth-grade option')].map(o => o.value),
    turmas6: [...document.querySelectorAll('#auth-grade option')].find(o => o.value === '6ano') ? true : false
  })`);
  check('Tela de cadastro aparece primeiro', authScreen.visivel === true && authScreen.appEscondido === true);
  check('Series 6ano ate 3em disponiveis', authScreen.series.join(',') === '6ano,7ano,8ano,9ano,1em,2em,3em', authScreen.series.join(','));

  // Turmas de cada serie
  const turmas = await evaluate(`(async () => {
    const out = {};
    for (const g of ['6ano', '7ano', '8ano', '9ano', '1em', '2em', '3em']) {
      document.querySelector('#auth-grade').value = g;
      document.querySelector('#auth-grade').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      out[g] = [...document.querySelectorAll('#auth-class option')].map(o => o.value).join(',');
    }
    return out;
  })()`);
  check('6ano a 9ano: turmas A, B e C', turmas['6ano'] === 'A,B,C' && turmas['9ano'] === 'A,B,C', turmas['6ano'] + ' | ' + turmas['9ano']);
  check('1o EM: turmas A, B, C, DSB e ADM', turmas['1em'] === 'A,B,C,DSB,ADM', turmas['1em']);
  check('2o e 3o EM: turmas A, B e C', turmas['2em'] === 'A,B,C' && turmas['3em'] === 'A,B,C', turmas['2em'] + ' | ' + turmas['3em']);

  // 0b. Cadastro de um aluno
  const cadastro = await evaluate(`(async () => {
    document.querySelector('#auth-grade').value = '1em';
    document.querySelector('#auth-grade').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    document.querySelector('#auth-class').value = 'DSB';
    document.querySelector('#auth-class').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#auth-name').value = 'Maria E2E Silva';
    document.querySelector('#auth-name').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#auth-form').requestSubmit();
    await new Promise(r => setTimeout(r, 1200));
    const sessao = JSON.parse(localStorage.getItem('taskschool:session') || 'null');
    return {
      appVisivel: !document.querySelector('#app').hidden,
      authEscondido: document.querySelector('#auth-screen').hidden,
      sessao,
      nomeNaTela: document.querySelector('#user-name').textContent,
      turmaNaTela: document.querySelector('#user-class').textContent,
      inicial: document.querySelector('#user-initial').textContent
    };
  })()`);
  check('Cadastro entra no aplicativo', cadastro.appVisivel === true && cadastro.authEscondido === true);
  check('Sessao salva no localStorage', cadastro.sessao && cadastro.sessao.classKey === '1em-DSB', JSON.stringify(cadastro.sessao));
  check('Nome e turma no cabecalho', cadastro.nomeNaTela === 'Maria E2E Silva' && /DSB/.test(cadastro.turmaNaTela), cadastro.nomeNaTela + ' / ' + cadastro.turmaNaTela);
  check('Avatar com iniciais', cadastro.inicial === 'MS', cadastro.inicial);

  // 0c. Tarefas da turma (vazia) e acoes da API
  const escopo = await evaluate(`(async () => {
    const daTurma = await fetch('/api/tasks?classKey=9ano-B').then(r => r.json());
    const todas = await fetch('/api/tasks').then(r => r.json());
    const demo = await fetch('/api/tasks?classKey=6ano-A').then(r => r.json());
    return {
      daTurma: daTurma.length,
      todas: todas.length,
      demo: demo.length,
      array: Array.isArray(daTurma)
    };
  })()`);
  check(
    'Filtro por turma funciona na API',
    escopo.array === true && escopo.daTurma === 0 && escopo.demo >= 5 && escopo.todas >= escopo.demo,
    JSON.stringify(escopo)
  );

  // 0. Tela de cadastro
  // 0d. Tarefas sao compartilhadas por turma: outro aluno da mesma turma veem a tarefa
  const compartilhamento = await evaluate(`(async () => {
    const resposta = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Joao E2E Souza', grade: '1em', className: 'DSB' })
    });
    const joao = await resposta.json();
    const antes = await fetch('/api/tasks?classKey=1em-DSB').then(r => r.json());
    // cria tarefa como Joao
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tarefa do Joao', subject: 'Historia', studentId: joao.id })
    });
    const depois = await fetch('/api/tasks?classKey=1em-DSB').then(r => r.json());
    const outraTurma = await fetch('/api/tasks?classKey=1em-A').then(r => r.json());
    const idJoao = await fetch('/api/tasks?classKey=1em-DSB').then(r => r.json());
    return {
      mesmoNome: joao.name,
      criado: joao.created,
      antes: antes.length,
      depois: depois.length,
      outraTurma: outraTurma.length,
      autor: idJoao[0] ? idJoao[0].authorName : null
    };
  })()`);
  check('Segundo aluno da mesma turma cadastrado', compartilhamento.criado === true);
  check('Tarefa aparece para a turma inteira', compartilhamento.depois === compartilhamento.antes + 1, JSON.stringify(compartilhamento));
  check('Tarefa nao vaza para outra turma', compartilhamento.outraTurma === 0, String(compartilhamento.outraTurma));
  check('Tarefa registra o autor', compartilhamento.autor === 'Joao E2E Souza', String(compartilhamento.autor));

  // 1b. Tema escuro + cor verde
  const theme = await evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: getComputedStyle(document.body).backgroundColor,
      surface: getComputedStyle(document.querySelector('.card')).backgroundColor,
      primary: cs.getPropertyValue('--color-primary').trim(),
      scheme: cs.colorScheme
    };
  })()`);
  check('Tema escuro aplicado', theme.bg === 'rgb(14, 18, 22)', theme.bg);
  check('Cor primaria verde #218a31', theme.primary === '#218a31', theme.primary);
  check('color-scheme dark no navegador', theme.scheme === 'dark', theme.scheme);

  // 1c. O CSS servido ao browser (via Service Worker) precisa ser o atual
  const cssServed = await evaluate(`(async () => {
    const css = await fetch('/style.css').then(r => r.text());
    return {
      verde: css.includes('#218a31'),
      azulAntigo: css.includes('#4f46e5'),
      semPrioridade: !css.includes('badge-priority')
    };
  })()`);
  check('CSS entregue pelo Service Worker ja e o verde', cssServed.verde === true);
  check('CSS nao contem o azul antigo', cssServed.azulAntigo === false);
  check('CSS nao contem estilos de prioridade', cssServed.semPrioridade === true);

  // 2. Criar tarefa pelo formulario
  const created = await evaluate(`(async () => {
    const set = (sel, val) => {
      const el = document.querySelector(sel);
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#title', 'Tarefa E2E automatizada');
    set('#subject', 'Automacao');
    set('#dueDate', '2026-12-01');
    document.querySelector('#task-form').requestSubmit();
    await new Promise(r => setTimeout(r, 1200));
    const items = [...document.querySelectorAll('#list-pending .task')];
    const novo = items.find(i => i.querySelector('.task-title').textContent.includes('E2E'));
    return {
      criado: !!novo,
      texto: novo ? novo.querySelector('.task-title').textContent : null,
      disciplina: novo ? novo.querySelector('.badge-subject').textContent : null,
      prazo: novo ? novo.querySelector('.badge-date').textContent : null,
      temPrioridade: !!novo.querySelector('.badge-priority'),
      toast: document.querySelector('.toast')?.textContent || null,
      statPendentes: document.querySelector('#stat-pending').textContent
    };
  })()`);
  check('Formulario cria tarefa', created.criado, created.texto);
  check('Disciplina preenchida', created.disciplina === 'Automacao', String(created.disciplina));
  check('Prazo formatado em pt-BR', /dez/i.test(created.prazo || ''), String(created.prazo));
  check('Sem campo de prioridade na interface', created.temPrioridade === false);
  check('Contador de pendentes atualiza', Number(created.statPendentes) > 0, created.statPendentes);

  // 3. Validacao: titulo vazio
  const invalid = await evaluate(`(async () => {
    document.querySelector('#title').value = '';
    document.querySelector('#task-form').requestSubmit();
    await new Promise(r => setTimeout(r, 300));
    return {
      erroVisivel: document.querySelector('#error-title').classList.contains('visible'),
      textoErro: document.querySelector('#error-title').textContent
    };
  })()`);
  check('Validacao de titulo vazio', invalid.erroVisivel && invalid.textoErro.length > 0, invalid.textoErro);

  // 4. Marcar como concluida
  const toggled = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('#list-pending .task')].find(i => i.querySelector('.task-title').textContent.includes('E2E'));
    const box = item.querySelector('.task-toggle');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1000));
    const moved = [...document.querySelectorAll('#list-completed .task')].some(i => i.querySelector('.task-title').textContent.includes('E2E'));
    return { moved, statConcluidas: document.querySelector('#stat-completed').textContent };
  })()`);
  check('Concluir move para a lista de concluidas', toggled.moved, JSON.stringify(toggled));

  // 5. Editar tarefa
  const edited = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('#list-completed .task')].find(i => i.querySelector('.task-title').textContent.includes('E2E'));
    item.querySelector('.btn-edit').click();
    await new Promise(r => setTimeout(r, 400));
    const emEdicao = document.querySelector('#form-heading-text').textContent;
    const tituloCarregado = document.querySelector('#title').value;
    const cancelVisivel = !document.querySelector('#cancel-edit').hidden;
    document.querySelector('#title').value = 'Tarefa E2E EDITADA';
    document.querySelector('#title').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#task-form').requestSubmit();
    await new Promise(r => setTimeout(r, 1200));
    return {
      emEdicao,
      tituloCarregado,
      cancelVisivel,
      headingDepois: document.querySelector('#form-heading-text').textContent,
      editada: [...document.querySelectorAll('.task-title')].some(t => t.textContent.includes('EDITADA'))
    };
  })()`);
  check('Botao editar carrega o formulario', edited.emEdicao === 'Editar tarefa' && edited.tituloCarregado.includes('E2E'), edited.emEdicao);
  check('Botao cancelar edicao aparece', edited.cancelVisivel === true);
  check('Edicao persiste o novo titulo', edited.editada === true);
  check('Formulario volta para "Nova tarefa"', edited.headingDepois === 'Nova tarefa', edited.headingDepois);

  // 6. Filtro de busca
  const search = await evaluate(`(async () => {
    const input = document.querySelector('#search');
    input.value = 'EDITADA';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const visiveis = document.querySelectorAll('.task-list .task').length;
    const contem = [...document.querySelectorAll('.task-title')].some(t => t.textContent.includes('EDITADA'));
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { visiveis, contem, restaurado: document.querySelectorAll('.task-list .task').length };
  })()`);
  check('Busca filtra a lista', search.visiveis === 1 && search.contem, JSON.stringify(search));

  // 7. Aba "Pendentes"
  const tab = await evaluate(`(async () => {
    document.querySelector('.tab[data-filter="pending"]').click();
    await new Promise(r => setTimeout(r, 300));
    const concluidasVisiveis = document.querySelectorAll('#list-completed .task').length;
    document.querySelector('.tab[data-filter="all"]').click();
    await new Promise(r => setTimeout(r, 300));
    return { concluidasVisiveis, restaurado: document.querySelectorAll('#list-completed .task').length };
  })()`);
  check('Aba "Pendentes" oculta concluidas', tab.concluidasVisiveis === 0, JSON.stringify(tab));

  // 8. Excluir tarefa
  const removed = await evaluate(`(async () => {
    const original = window.confirm;
    window.confirm = () => true;
    const item = [...document.querySelectorAll('.task')].find(i => i.querySelector('.task-title').textContent.includes('EDITADA'));
    item.querySelector('.btn-delete').click();
    await new Promise(r => setTimeout(r, 1200));
    window.confirm = original;
    return {
      aindaExiste: [...document.querySelectorAll('.task-title')].some(t => t.textContent.includes('EDITADA')),
      toast: document.querySelector('.toast')?.textContent || null
    };
  })()`);
  check('Exclusao remove a tarefa da lista', removed.aindaExiste === false, JSON.stringify(removed));

  // 9. Service Worker + manifest
  const pwa = await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    const manifest = await fetch('/manifest.json').then(r => r.json());
    return {
      swCount: regs.length,
      swAtivo: regs.length > 0,
      manifestNome: manifest.name,
      display: manifest.display,
      icones: manifest.icons.length
    };
  })()`);
  check('Service Worker registrado', pwa.swAtivo, JSON.stringify(pwa));
  check('Manifesto PWA valido', pwa.display === 'standalone' && pwa.icones >= 2, JSON.stringify(pwa));

  // 10. Erros de console
  check('Sem erros de JavaScript no console', consoleErrors.length === 0, consoleErrors.join(' | '));

  // 11. Modo offline (PWA): sem rede, a tarefa e salva localmente e enfileirada
  console.log('\n-> Testando modo offline');
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await sleep(1500);

  const offlineState = await evaluate(`({
    bannerVisivel: !document.querySelector('#offline-banner').hidden,
    onLine: navigator.onLine
  })`);
  check('Banner offline aparece sem conexao', offlineState.bannerVisivel === true, JSON.stringify(offlineState));

  const offlineCreate = await evaluate(`(async () => {
    document.querySelector('#title').value = 'Tarefa criada OFFLINE';
    document.querySelector('#title').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#task-form').requestSubmit();
    await new Promise(r => setTimeout(r, 900));
    const fila = JSON.parse(localStorage.getItem('taskschool:queue') || '[]');
    return {
      naLista: [...document.querySelectorAll('.task-title')].some(t => t.textContent.includes('OFFLINE')),
      totalFila: fila.length,
      metodo: fila[0] ? fila[0].method : null
    };
  })()`);
  check('Tarefa criada offline aparece na lista', offlineCreate.naLista === true, JSON.stringify(offlineCreate));
  check('Mutacao offline entra na fila', offlineCreate.totalFila > 0, JSON.stringify(offlineCreate));

  // 12. Reconexao: a fila e sincronizada automaticamente
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await sleep(3000);

  const resync = await evaluate(`({
    fila: (JSON.parse(localStorage.getItem('taskschool:queue') || '[]')).length,
    bannerVisivel: !document.querySelector('#offline-banner').hidden
  })`);
  check('Fila e esvaziada ao reconectar', resync.fila === 0, JSON.stringify(resync));
  check('Banner offline some ao reconectar', resync.bannerVisivel === false, JSON.stringify(resync));

  // Confirma no servidor que a tarefa offline chegou ao banco
  const persisted = await fetch('http://localhost:3000/api/tasks')
    .then((r) => r.json())
    .then((list) => list.some((t) => t.title.includes('OFFLINE')));
  check('Tarefa offline persistida no SQLite', persisted === true);

  console.log('\n-----------------------------------------');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} verificacoes passaram`);
  if (failed.length) {
    console.log('FALHAS:', failed.map((f) => f.name).join(', '));
  }

  ws.close();
  chrome.kill();
  await sleep(800);
  cleanTestData();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* o Chrome ainda pode estar segurando o profile: ignora */
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Erro no teste E2E:', error);
  process.exit(1);
});
