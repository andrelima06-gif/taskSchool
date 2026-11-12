/* ==========================================================================
   TaskSchool — app.js
   Front-end Vanilla JS: cadastro por nome + turma, consumo da API REST,
   filtros, edição, exclusão e funcionamento offline (fila de sincronização).
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuração                                                        */
  /* ------------------------------------------------------------------ */

  const API_BASE = '/api';
  const STORAGE_KEYS = {
    session: 'taskschool:session',
    tasks: 'taskschool:tasks',
    queue: 'taskschool:queue',
    reminders: 'taskschool:reminders',
    reminderFired: 'taskschool:reminderFired',
  };

  const NOTIFICATION_TAG = 'taskschool-daily';
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  /* ------------------------------------------------------------------ */
  /* Lembretes diários (notificações)                                    */
  /* ------------------------------------------------------------------ */

  const notificationsSupported = () => 'Notification' in window && window.isSecureContext;

  const getReminderSettings = () => {
    const saved = readStorage(STORAGE_KEYS.reminders, null);
    return {
      enabled: Boolean(saved && saved.enabled),
      time: (saved && saved.time) || '18:00',
    };
  };

  const saveReminderSettings = (settings) => writeStorage(STORAGE_KEYS.reminders, settings);

  /** Envia o contexto (turma) ao Service Worker para os lembretes. */
  async function syncContextToSW() {
    if (!state.session) return;
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (!registration) return;
      const target = registration.active || registration.waiting || registration.installing;
      if (!target) return;
      target.postMessage({
        type: 'SET_CONTEXT',
        classKey: state.session.classKey,
        name: state.session.name,
      });
    } catch {
      /* sem SW: o lembrete ainda funciona via timer da página */
    }
  }

  /** Monta o aviso do dia (lógica compartilhada com o Service Worker). */
  function buildReminder(tasks) {
    if (window.TaskSchoolReminder) return window.TaskSchoolReminder.buildReminder(tasks);
    const pendentes = (tasks || []).filter((t) => !t.completed);
    return {
      title: pendentes.length ? `Você tem ${pendentes.length} tarefas para entregar` : 'Tudo em dia!',
      body: 'Abra o TaskSchool para ver as tarefas.',
      level: pendentes.length ? 'urgent' : 'clear',
      count: pendentes.length,
    };
  }

  /** Exibe a notificação do sistema. */
  async function showSystemNotification(title, body) {
    const options = {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: NOTIFICATION_TAG,
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: '/' },
      actions: [
        { action: 'open', title: 'Ver tarefas' },
        { action: 'dismiss', title: 'Dispensar' },
      ],
    };

    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.showNotification(title, options);
        return true;
      }
    } catch {
      /* cai para o Notification direto */
    }

    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body, icon: '/icons/icon-192.png', tag: NOTIFICATION_TAG });
      return true;
    } catch {
      return false;
    }
  }

  /** Dispara o aviso do dia. */
  async function runDailyReminder({ force = false, silent = false } = {}) {
    const settings = getReminderSettings();
    if (!settings.enabled && !force) return null;
    if (!notificationsSupported()) return null;
    if (Notification.permission !== 'granted') return null;

    // Atualiza a lista da turma para que o aviso reflita o estado atual.
    if (state.session) {
      try {
        const fresh = await api.list(state.session.classKey);
        if (Array.isArray(fresh)) {
          state.tasks = fresh;
          render();
        }
      } catch {
        /* offline: segue com a lista local */
      }
    }

    const reminder = buildReminder(state.tasks);
    if (reminder.level === 'clear' && !force) return reminder;

    await showSystemNotification(reminder.title, reminder.body);

    if (!silent) {
      writeStorage(STORAGE_KEYS.reminderFired, new Date().toISOString().slice(0, 10));
    }
    return reminder;
  }

  /** Agenda o disparo do próximo lembrete (reagenda a cada rodada). */
  function scheduleDailyReminder() {
    const settings = getReminderSettings();
    if (!settings.enabled) return;

    const [hours, minutes] = settings.time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours || 0, minutes || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1);
    setTimeout(() => {
      runDailyReminder({ force: true }).catch(() => {});
      scheduleDailyReminder();
    }, delay);
  }

  /** Se já passou o horário de hoje e o aviso não saiu, dispara agora. */
  function maybeRunDailyReminder() {
    const settings = getReminderSettings();
    if (!settings.enabled) return;
    if (!notificationsSupported() || Notification.permission !== 'granted') return;

    const [hours, minutes] = settings.time.split(':').map(Number);
    const now = new Date();
    const passou =
      now.getHours() > hours || (now.getHours() === hours && now.getMinutes() >= minutes);
    if (!passou) return;

    const today = new Date().toISOString().slice(0, 10);
    if (readStorage(STORAGE_KEYS.reminderFired, '') === today) return;

    runDailyReminder({ force: true }).catch(() => {});
  }

  /** Sincronização periódica: permite o aviso mesmo com o app fechado. */
  async function registerPeriodicSync() {
    if (!('periodicSync' in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.ready;
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state !== 'granted') return false;
      await registration.periodicSync.register(NOTIFICATION_TAG, { minInterval: ONE_DAY_MS });
      return true;
    } catch {
      return false;
    }
  }

  function updateReminderStatus() {
    const settings = getReminderSettings();

    els.reminderEnabled.checked = settings.enabled;
    els.reminderTime.value = settings.time;
    els.reminderTimeField.hidden = !settings.enabled;

    if (!('Notification' in window)) {
      setReminderStatus('Este navegador não suporta notificações.', 'warn');
      els.reminderEnabled.disabled = true;
      return;
    }
    if (!window.isSecureContext) {
      setReminderStatus(
        'Notificações exigem HTTPS (ou localhost). Abra o app por um endereço seguro.',
        'warn'
      );
      els.reminderEnabled.disabled = true;
      return;
    }

    els.reminderEnabled.disabled = false;

    if (Notification.permission === 'denied') {
      setReminderStatus(
        'As notificações estão bloqueadas. Libere-as nas permissões do navegador.',
        'warn'
      );
      return;
    }
    if (Notification.permission === 'default') {
      setReminderStatus(
        settings.enabled
          ? 'Permita as notificações para receber os lembretes.'
          : 'Ative o lembrete diário e permita as notificações.',
        ''
      );
      return;
    }

    const quando = settings.time;
    setReminderStatus(
      settings.enabled
        ? `Lembretes ativos: um aviso por dia às ${quando}.`
        : 'Lembretes desativados. Ative para receber um aviso por dia.',
      settings.enabled ? 'is-ok' : ''
    );
  }

  function setReminderStatus(message, modifier = '') {
    els.reminderStatus.textContent = message;
    els.reminderStatus.className = `reminder-status ${modifier}`.trim();
  }

  async function handleReminderToggle(event) {
    const enabled = event.target.checked;
    const settings = { ...getReminderSettings(), enabled };
    saveReminderSettings(settings);

    if (enabled) {
      if (!notificationsSupported()) {
        setReminderStatus('Este navegador não suporta notificações.', 'warn');
        event.target.checked = false;
        return;
      }

      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;

      if (permission === 'granted') {
        await syncContextToSW();
        await registerPeriodicSync();
        toast('Lembretes ativados! Você será avisado todo dia.', 'success');
      } else {
        setReminderStatus(
          'Permissão negada. Libere as notificações nas configurações do navegador.',
          'warn'
        );
        event.target.checked = false;
        saveReminderSettings({ ...settings, enabled: false });
      }
    }

    els.reminderTimeField.hidden = !enabled;
    updateReminderStatus();
    if (enabled) scheduleDailyReminder();
  }

  function handleReminderTime(event) {
    const settings = { ...getReminderSettings(), time: event.target.value || '18:00' };
    saveReminderSettings(settings);
    updateReminderStatus();
    scheduleDailyReminder();
  }

  async function handleReminderTest() {
    if (!notificationsSupported()) {
      toast('Notificações não disponíveis neste navegador.', 'error');
      return;
    }

    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Permissão de notificações não concedida.', 'error');
      return;
    }

    await syncContextToSW();
    const result = await runDailyReminder({ force: true, silent: true });

    if (result) {
      toast('Aviso de teste enviado!', 'success');
    } else {
      toast('Não foi possível enviar o aviso.', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Estado da aplicação                                                 */
  /* ------------------------------------------------------------------ */

  const state = {
    session: null, // { id, name, grade, className, classKey, classLabel }
    grades: [],
    tasks: [],
    filter: 'all',
    search: '',
    subject: '',
    editingId: null,
    online: navigator.onLine,
  };

  /* ------------------------------------------------------------------ */
  /* Atalhos de DOM                                                      */
  /* ------------------------------------------------------------------ */

  const $ = (selector) => document.querySelector(selector);

  const els = {
    // Cadastro
    authScreen: $('#auth-screen'),
    authForm: $('#auth-form'),
    authName: $('#auth-name'),
    authGrade: $('#auth-grade'),
    authClass: $('#auth-class'),
    authSubmit: $('#auth-submit'),
    authSubmitLabel: $('#auth-submit-label'),
    authNameError: $('#error-auth-name'),
    existingStudents: $('#existing-students'),
    existingList: $('#existing-list'),

    // Aplicativo
    app: $('#app'),
    form: $('#task-form'),
    idInput: $('#task-id'),
    titleInput: $('#title'),
    subjectInput: $('#subject'),
    dueDateInput: $('#dueDate'),
    submitBtn: $('#submit-btn'),
    submitLabel: $('#submit-label'),
    formHeading: $('#form-heading-text'),
    cancelEdit: $('#cancel-edit'),
    titleError: $('#error-title'),
    searchInput: $('#search'),
    filterSubject: $('#filter-subject'),
    subjectsList: $('#subjects-list'),
    tabs: Array.from(document.querySelectorAll('.tab')),
    listPending: $('#list-pending'),
    listCompleted: $('#list-completed'),
    emptyPending: $('#empty-pending'),
    emptyCompleted: $('#empty-completed'),
    countPending: $('#count-pending'),
    countCompleted: $('#count-completed'),
    statPending: $('#stat-pending'),
    statCompleted: $('#stat-completed'),
    statOverdue: $('#stat-overdue'),
    toastContainer: $('#toast-container'),
    offlineBanner: $('#offline-banner'),
    template: $('#task-item-template'),

    // Usuário
    classLabel: $('#class-label'),
    userChip: $('#user-chip'),
    userInitial: $('#user-initial'),
    userName: $('#user-name'),
    userClass: $('#user-class'),
    installBtn: $('#install-btn'),

    // Lembretes
    reminderEnabled: $('#reminder-enabled'),
    reminderTime: $('#reminder-time'),
    reminderTimeField: $('#reminder-time-field'),
    reminderStatus: $('#reminder-status'),
    reminderTest: $('#reminder-test'),

    // Shell mobile
    navItems: Array.from(document.querySelectorAll('.nav-item')),
    fab: $('#fab'),
    mobileBacks: Array.from(document.querySelectorAll('.mobile-back')),
    studentAvatar: $('#student-avatar'),
    studentName: $('#student-name'),
    studentClass: $('#student-class'),
    switchStudent: $('#switch-student'),
    installBtnMobile: $('#install-btn-mobile'),
  };

  /* ------------------------------------------------------------------ */
  /* Navegação entre telas (versão mobile)                               */
  /* ------------------------------------------------------------------ */

  const MOBILE_VIEWS = ['tasks', 'new', 'reminders', 'student'];

  /** Troca a tela exibida no shell mobile. */
  function setMobileView(view) {
    const target = MOBILE_VIEWS.includes(view) ? view : 'tasks';
    els.app.dataset.view = target;
    els.navItems.forEach((item) => {
      const active = item.dataset.view === target;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    if (target === 'tasks') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Volta para a lista de tarefas (após salvar, por exemplo). */
  function backToTasks() {
    setMobileView('tasks');
  }

  /* ------------------------------------------------------------------ */
  /* Instalação do PWA                                                   */
  /* ------------------------------------------------------------------ */

  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    // O Chrome oferece a instalação do app como PWA.
    event.preventDefault();
    deferredInstallPrompt = event;
    if (els.installBtn) els.installBtn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (els.installBtn) els.installBtn.hidden = true;
    toast('TaskSchool instalado com sucesso!', 'success');
  });

  async function installApp() {
    if (!deferredInstallPrompt) {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      toast(
        isIOS
          ? 'No iPhone: Compartilhar > "Adicionar à Tela de Início".'
          : 'Use o menu do navegador: "Instalar aplicativo".',
        'info',
        5000
      );
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      toast('Instalando o TaskSchool...', 'success');
    }
    deferredInstallPrompt = null;
    if (els.installBtn) els.installBtn.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  const todayISO = () => new Date().toISOString().slice(0, 10);

  function formatDate(iso) {
    if (!iso) return null;
    const [year, month, day] = iso.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** Gera um id inteiro positivo (seguro) para tarefas criadas offline. */
  function generateClientId() {
    const buf = new Uint32Array(2);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    // Mantém dentro de Number.MAX_SAFE_INTEGER para não perder precisão.
    const id = buf[0] * 2097152 + (buf[1] % 2097152);
    return 1000000000 + (id % 8999999999);
  }

  /* ------------------------------------------------------------------ */
  /* Armazenamento local (sessão + cache + fila offline)                  */
  /* ------------------------------------------------------------------ */

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage indisponível (modo privado) — segue sem cache local */
    }
  }

  const cacheTasks = () => writeStorage(STORAGE_KEYS.tasks, state.tasks);
  const loadCachedTasks = () => readStorage(STORAGE_KEYS.tasks, []);

  const getQueue = () => readStorage(STORAGE_KEYS.queue, []);
  const saveQueue = (queue) => writeStorage(STORAGE_KEYS.queue, queue);
  const enqueue = (mutation) => {
    const queue = getQueue();
    queue.push(mutation);
    saveQueue(queue);
  };

  const saveSession = (session) => writeStorage(STORAGE_KEYS.session, session);
  const loadSession = () => readStorage(STORAGE_KEYS.session, null);
  const clearSession = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.session);
    } catch {
      /* ignora */
    }
  };

  /* ------------------------------------------------------------------ */
  /* Cliente HTTP                                                        */
  /* ------------------------------------------------------------------ */

  async function request(path, options = {}) {
    const config = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    };

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, config);
    } catch (error) {
      const err = new Error('Sem conexão com o servidor.');
      err.isNetwork = true;
      err.original = error;
      throw err;
    }

    if (response.status === 204) return null;

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const err = new Error((payload && payload.error && payload.error.message) || `Erro ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return payload;
  }

  const api = {
    grades: () => request('/grades'),
    register: (payload) => request('/students', { method: 'POST', body: payload }),
    studentsOf: (classKey) => request(`/students?classKey=${encodeURIComponent(classKey)}`),
    list: (classKey) => request(`/tasks?classKey=${encodeURIComponent(classKey)}`),
    create: (task) => request('/tasks', { method: 'POST', body: task }),
    update: (id, task) => request(`/tasks/${id}`, { method: 'PUT', body: task }),
    toggle: (id, completed) => request(`/tasks/${id}`, { method: 'PATCH', body: { completed } }),
    remove: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  };

  /* ------------------------------------------------------------------ */
  /* Notificações (toasts)                                               */
  /* ------------------------------------------------------------------ */

  function toast(message, type = 'info', timeout = 3200) {
    const el = document.createElement('div');
    el.className = `toast is-${type}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, timeout);
  }

  /* ------------------------------------------------------------------ */
  /* Tela de cadastro                                                    */
  /* ------------------------------------------------------------------ */

  async function loadGrades() {
    try {
      const grades = await api.grades();
      state.grades = Array.isArray(grades) ? grades : [];
    } catch (error) {
      // Fallback local caso a API não responda (primeiro acesso offline).
      state.grades = [
        { id: '6ano', label: '6º ano', classes: ['A', 'B', 'C'] },
        { id: '7ano', label: '7º ano', classes: ['A', 'B', 'C'] },
        { id: '8ano', label: '8º ano', classes: ['A', 'B', 'C'] },
        { id: '9ano', label: '9º ano', classes: ['A', 'B', 'C'] },
        { id: '1em', label: '1º ano do Ensino Médio', classes: ['A', 'B', 'C', 'DSB', 'ADM'] },
        { id: '2em', label: '2º ano do Ensino Médio', classes: ['A', 'B', 'C'] },
        { id: '3em', label: '3º ano do Ensino Médio', classes: ['A', 'B', 'C'] },
      ];
    }

    els.authGrade.replaceChildren(...state.grades.map((g) => new Option(g.label, g.id)));
    fillClassOptions();
  }

  function fillClassOptions() {
    const grade = state.grades.find((g) => g.id === els.authGrade.value) || state.grades[0];
    const previous = els.authClass.value;
    els.authClass.replaceChildren(...(grade ? grade.classes : []).map((c) => new Option(c, c)));
    if (previous && [...els.authClass.options].some((o) => o.value === previous)) {
      els.authClass.value = previous;
    }
    loadExistingStudents();
  }

  function currentClassKey() {
    const grade = els.authGrade.value;
    const className = els.authClass.value;
    if (!grade || !className) return null;
    return `${grade}-${className}`;
  }

  /** Mostra os alunos já cadastrados na turma escolhida. */
  async function loadExistingStudents() {
    const classKey = currentClassKey();
    if (!classKey) return;

    try {
      const students = await api.studentsOf(classKey);
      els.existingList.replaceChildren(
        ...students.map((student) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'student-pill';
          button.innerHTML = `<span class="pill-avatar">${initials(student.name)}</span><span>${student.name}</span>`;
          button.addEventListener('click', () => enterAs(student));
          return button;
        })
      );
      els.existingStudents.hidden = students.length === 0;
    } catch {
      els.existingStudents.hidden = true;
    }
  }

  async function enterAs(student) {
    const session = {
      id: student.id,
      name: student.name,
      grade: student.grade,
      className: student.className,
      classKey: student.classKey,
      classLabel: student.classLabel || student.classKey,
    };
    saveSession(session);
    state.session = session;
    showApp();
    await loadTasks();
    await syncContextToSW();
    scheduleDailyReminder();
    toast(`Bem-vindo(a), ${student.name}!`, 'success');
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    showAuthError('');

    const name = els.authName.value.trim();
    const grade = els.authGrade.value;
    const className = els.authClass.value;

    if (name.length < 2) {
      showAuthError('Informe seu nome completo (mínimo 2 letras).');
      els.authName.focus();
      return;
    }
    if (!grade || !className) {
      showAuthError('Selecione a série e a turma.');
      return;
    }

    els.authSubmit.disabled = true;
    els.authSubmitLabel.textContent = 'Entrando...';

    try {
      const student = await api.register({ name, grade, className });
      const session = {
        id: student.id,
        name: student.name,
        grade: student.grade,
        className: student.className,
        classKey: student.classKey,
        classLabel: student.classLabel || student.classKey,
      };
      saveSession(session);
      state.session = session;
      showApp();
      await loadTasks();
      await syncContextToSW();
      scheduleDailyReminder();
      toast(student.created ? `Cadastro feito, ${student.name}!` : `Bem-vindo de volta, ${student.name}!`, 'success');
    } catch (error) {
      showAuthError(error.message);
    } finally {
      els.authSubmit.disabled = false;
      els.authSubmitLabel.textContent = 'Entrar na turma';
    }
  }

  function showAuthError(message) {
    els.authNameError.textContent = message;
    els.authNameError.classList.toggle('visible', Boolean(message));
    els.authName.classList.toggle('invalid', Boolean(message));
  }

  function showAuthScreen() {
    state.session = null;
    state.tasks = [];
    state.editingId = null;
    els.authScreen.hidden = false;
    els.app.hidden = true;
    els.authName.focus();
    loadExistingStudents();
  }

  function showApp() {
    els.authScreen.hidden = true;
    els.app.hidden = false;
    updateUserChip();
    setMobileView('tasks');
  }

  function updateUserChip() {
    const session = state.session;
    if (!session) return;
    els.userInitial.textContent = initials(session.name);
    els.userName.textContent = session.name;
    els.userClass.textContent = session.classLabel || session.classKey;
    els.classLabel.textContent = `Turma ${session.classLabel || session.classKey}`;

    // Cartão "Aluno" (tela mobile)
    if (els.studentAvatar) {
      els.studentAvatar.textContent = initials(session.name);
      els.studentName.textContent = session.name;
      els.studentClass.textContent = session.classLabel || session.classKey;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Renderização                                                         */
  /* ------------------------------------------------------------------ */

  function matchesFilters(task) {
    if (state.filter === 'pending' && task.completed) return false;
    if (state.filter === 'completed' && !task.completed) return false;

    if (state.subject && task.subject !== state.subject) return false;

    if (state.search) {
      const term = state.search.toLowerCase();
      const haystack = `${task.title} ${task.subject} ${task.authorName || ''}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }

    return true;
  }

  function buildTaskElement(task) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;

    const toggle = node.querySelector('.task-toggle');
    toggle.checked = Boolean(task.completed);
    toggle.addEventListener('change', () => handleToggle(task, toggle.checked));

    const titleEl = node.querySelector('.task-title');
    titleEl.textContent = task.title;

    const subjectBadge = node.querySelector('.badge-subject');
    subjectBadge.textContent = task.subject || 'Geral';

    const dateBadge = node.querySelector('.badge-date');
    if (task.dueDate) {
      dateBadge.textContent = `Prazo: ${formatDate(task.dueDate)}`;
      const overdue = !task.completed && task.dueDate < todayISO();
      if (overdue) {
        dateBadge.classList.add('overdue');
        dateBadge.textContent = `Atrasada — ${formatDate(task.dueDate)}`;
      }
    } else {
      dateBadge.remove();
    }

    const authorBadge = node.querySelector('.badge-author');
    if (task.authorName) {
      authorBadge.textContent = task.authorName;
      if (state.session && task.authorName === state.session.name) {
        authorBadge.classList.add('is-me');
      }
    } else {
      authorBadge.remove();
    }

    node.querySelector('.btn-edit').addEventListener('click', () => startEdit(task));
    node.querySelector('.btn-delete').addEventListener('click', () => handleDelete(task));

    if (task.completed) node.classList.add('is-completed');

    return node;
  }

  function render() {
    const pending = state.tasks.filter((t) => !t.completed);
    const completed = state.tasks.filter((t) => t.completed);

    const visiblePending = pending.filter(matchesFilters);
    const visibleCompleted = completed.filter(matchesFilters);

    els.listPending.replaceChildren(...visiblePending.map(buildTaskElement));
    els.listCompleted.replaceChildren(...visibleCompleted.map(buildTaskElement));

    els.countPending.textContent = visiblePending.length;
    els.countCompleted.textContent = visibleCompleted.length;
    els.emptyPending.hidden = visiblePending.length > 0;
    els.emptyCompleted.hidden = visibleCompleted.length > 0;

    // Resumo geral (ignora os filtros de visualização).
    const overdue = pending.filter((t) => t.dueDate && t.dueDate < todayISO()).length;
    els.statPending.textContent = pending.length;
    els.statCompleted.textContent = completed.length;
    els.statOverdue.textContent = overdue;

    renderSubjects();
    cacheTasks();
  }

  function renderSubjects() {
    const subjects = [...new Set(state.tasks.map((t) => t.subject).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'pt-BR')
    );

    // Select de filtro
    const current = state.subject;
    els.filterSubject.replaceChildren(new Option('Todas as disciplinas', ''));
    subjects.forEach((subject) => els.filterSubject.appendChild(new Option(subject, subject)));
    els.filterSubject.value = current;

    // Datalist do formulário
    els.subjectsList.replaceChildren(...subjects.map((subject) => new Option(subject)));
  }

  /* ------------------------------------------------------------------ */
  /* Carregamento dos dados                                               */
  /* ------------------------------------------------------------------ */

  async function loadTasks() {
    if (!state.session) return;
    els.listPending.classList.add('is-loading');

    try {
      const tasks = await api.list(state.session.classKey);
      state.tasks = Array.isArray(tasks) ? tasks : [];
      render();
      await flushQueue();
    } catch (error) {
      if (error.isNetwork) {
        state.tasks = loadCachedTasks();
        render();
        updateOnlineState(false);
        toast('Sem conexão. Exibindo dados salvos.', 'info');
      } else {
        toast(error.message, 'error');
      }
    } finally {
      els.listPending.classList.remove('is-loading');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Fila offline                                                         */
  /* ------------------------------------------------------------------ */

  async function flushQueue() {
    const queue = getQueue();
    if (!queue.length || !navigator.onLine) return;

    const remaining = [];
    let synced = 0;

    for (const mutation of queue) {
      try {
        if (mutation.method === 'POST') {
          await api.create(mutation.body);
        } else if (mutation.method === 'PUT') {
          await api.update(mutation.id, mutation.body);
        } else if (mutation.method === 'PATCH') {
          await api.toggle(mutation.id, mutation.body.completed);
        } else if (mutation.method === 'DELETE') {
          await api.remove(mutation.id);
        }
        synced += 1;
      } catch (error) {
        if (error.isNetwork) {
          remaining.push(mutation);
        } else {
          // Erro de validação (4xx): descarta a mutação para não travar a fila.
          console.warn('Mutação descartada:', mutation, error.message);
        }
      }
    }

    saveQueue(remaining);

    if (synced > 0) {
      toast(`${synced} alteração(ões) sincronizada(s).`, 'success');
      try {
        const tasks = await api.list(state.session.classKey);
        state.tasks = Array.isArray(tasks) ? tasks : [];
        render();
      } catch {
        /* mantém a lista local */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ações do usuário                                                     */
  /* ------------------------------------------------------------------ */

  function readForm() {
    return {
      title: els.titleInput.value.trim(),
      subject: els.subjectInput.value.trim() || 'Geral',
      dueDate: els.dueDateInput.value || null,
    };
  }

  function showTitleError(message) {
    els.titleError.textContent = message;
    els.titleError.classList.toggle('visible', Boolean(message));
    els.titleInput.classList.toggle('invalid', Boolean(message));
  }

  function setSubmitting(isSubmitting) {
    els.submitBtn.disabled = isSubmitting;
    els.submitLabel.textContent = isSubmitting
      ? 'Salvando...'
      : state.editingId
        ? 'Salvar alterações'
        : 'Adicionar tarefa';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    showTitleError('');

    if (!state.session) {
      toast('Faça o cadastro primeiro.', 'error');
      return;
    }

    const payload = { ...readForm(), studentId: state.session.id };
    if (!payload.title) {
      showTitleError('Informe o título da tarefa.');
      els.titleInput.focus();
      return;
    }

    setSubmitting(true);

    try {
      if (state.editingId) {
        const updated = await api.update(state.editingId, payload);
        state.tasks = state.tasks.map((task) => (task.id === state.editingId ? updated : task));
        toast('Tarefa atualizada!', 'success');
        resetForm();
        backToTasks();
      } else {
        const created = await api.create(payload);
        state.tasks.push(created);
        toast('Tarefa adicionada!', 'success');
        resetForm();
        backToTasks();
      }
      render();
    } catch (error) {
      if (error.isNetwork) {
        // Modo offline: aplica localmente e enfileira para sincronizar depois.
        if (state.editingId) {
          state.tasks = state.tasks.map((task) =>
            task.id === state.editingId ? { ...task, ...payload } : task
          );
          enqueue({ method: 'PUT', id: state.editingId, body: payload });
          toast('Salvo localmente. Sincronizaremos depois.', 'info');
          resetForm();
        } else {
          const tempId = generateClientId();
          state.tasks.push({ id: tempId, ...payload, completed: 0, authorName: state.session.name });
          enqueue({ method: 'POST', body: { id: tempId, ...payload, completed: 0 } });
          toast('Salvo localmente. Sincronizaremos depois.', 'info');
          resetForm();
        }
        render();
        updateOnlineState(false);
      } else {
        toast(error.message, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(task, completed) {
    const previous = state.tasks.find((t) => t.id === task.id);
    if (!previous) return;

    // Atualização otimista na interface.
    state.tasks = state.tasks.map((t) => (t.id === task.id ? { ...t, completed: completed ? 1 : 0 } : t));
    render();

    try {
      const updated = await api.toggle(task.id, completed);
      state.tasks = state.tasks.map((t) => (t.id === task.id ? updated : t));
      render();
    } catch (error) {
      if (error.isNetwork) {
        enqueue({ method: 'PATCH', id: task.id, body: { completed: completed ? 1 : 0 } });
        toast('Salvo localmente. Sincronizaremos depois.', 'info');
        updateOnlineState(false);
      } else {
        // Reverte para o estado anterior.
        state.tasks = state.tasks.map((t) => (t.id === task.id ? previous : t));
        render();
        toast(error.message, 'error');
      }
    }
  }

  async function handleDelete(task) {
    const confirmed = window.confirm(`Excluir a tarefa "${task.title}"?`);
    if (!confirmed) return;

    const snapshot = state.tasks;
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    render();

    try {
      await api.remove(task.id);
      toast('Tarefa excluída.', 'success');
      if (state.editingId === task.id) resetForm();
    } catch (error) {
      if (error.isNetwork) {
        enqueue({ method: 'DELETE', id: task.id });
        toast('Exclusão agendada. Sincronizaremos depois.', 'info');
        updateOnlineState(false);
      } else {
        state.tasks = snapshot;
        render();
        toast(error.message, 'error');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Edição                                                               */
  /* ------------------------------------------------------------------ */

  function startEdit(task) {
    state.editingId = task.id;
    els.idInput.value = task.id;
    els.titleInput.value = task.title;
    els.subjectInput.value = task.subject || '';
    els.dueDateInput.value = task.dueDate || '';

    els.formHeading.textContent = 'Editar tarefa';
    els.submitLabel.textContent = 'Salvar alterações';
    els.cancelEdit.hidden = false;
    els.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.titleInput.focus();
  }

  function resetForm() {
    state.editingId = null;
    els.form.reset();
    els.idInput.value = '';
    els.formHeading.textContent = 'Nova tarefa';
    els.submitLabel.textContent = 'Adicionar tarefa';
    els.cancelEdit.hidden = true;
    showTitleError('');
  }

  /* ------------------------------------------------------------------ */
  /* Filtros                                                              */
  /* ------------------------------------------------------------------ */

  function handleTabClick(event) {
    const tab = event.currentTarget;
    state.filter = tab.dataset.filter;
    els.tabs.forEach((btn) => {
      const active = btn === tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    render();
  }

  function handleSearch(event) {
    state.search = event.target.value.trim();
    render();
  }

  function handleSubjectFilter(event) {
    state.subject = event.target.value;
    render();
  }

  /* ------------------------------------------------------------------ */
  /* Estado online/offline                                                */
  /* ------------------------------------------------------------------ */

  function updateOnlineState(online) {
    state.online = online;
    els.offlineBanner.hidden = online;
  }

  /* ------------------------------------------------------------------ */
  /* Service Worker                                                       */
  /* ------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        console.warn('Falha ao registrar o Service Worker:', error);
      });
    };

    // A tela de cadastro é assíncrona: o evento "load" pode já ter passado.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inicialização                                                       */
  /* ------------------------------------------------------------------ */

  async function init() {
    els.authForm.addEventListener('submit', handleAuthSubmit);
    els.authGrade.addEventListener('change', fillClassOptions);
    els.authClass.addEventListener('change', loadExistingStudents);

    els.form.addEventListener('submit', handleSubmit);
    els.cancelEdit.addEventListener('click', resetForm);
    els.searchInput.addEventListener('input', handleSearch);
    els.filterSubject.addEventListener('change', handleSubjectFilter);
    els.tabs.forEach((tab) => tab.addEventListener('click', handleTabClick));

    els.userChip.addEventListener('click', () => {
      clearSession();
      showAuthScreen();
      toast('Troque de aluno para acessar outra turma.', 'info');
    });

    if (els.installBtn) els.installBtn.addEventListener('click', installApp);
    if (els.installBtnMobile) els.installBtnMobile.addEventListener('click', installApp);

    // Navegação mobile
    els.navItems.forEach((item) => {
      item.addEventListener('click', () => setMobileView(item.dataset.view));
    });
    if (els.fab) els.fab.addEventListener('click', () => setMobileView('new'));
    els.mobileBacks.forEach((button) => {
      button.addEventListener('click', () => setMobileView(button.dataset.go));
    });
    if (els.switchStudent) {
      els.switchStudent.addEventListener('click', () => {
        clearSession();
        showAuthScreen();
        toast('Troque de aluno para acessar outra turma.', 'info');
      });
    }

    els.reminderEnabled.addEventListener('change', handleReminderToggle);
    els.reminderTime.addEventListener('change', handleReminderTime);
    els.reminderTest.addEventListener('click', handleReminderTest);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.editingId) resetForm();
    });

    window.addEventListener('online', () => {
      updateOnlineState(true);
      toast('Conexão restabelecida. Sincronizando...', 'info');
      flushQueue();
      if (state.session) loadTasks();
    });

    window.addEventListener('offline', () => {
      updateOnlineState(false);
      toast('Você está offline. O modo local foi ativado.', 'info');
    });

    updateOnlineState(navigator.onLine);
    await loadGrades();

    const session = loadSession();
    if (session && session.id && session.classKey) {
      state.session = session;
      showApp();
      setMobileView('tasks');
      await loadTasks();
    } else {
      showAuthScreen();
    }

    // Lembretes: estado, agendamento e sincronização com o Service Worker.
    updateReminderStatus();
    if (state.session) {
      await syncContextToSW();
      scheduleDailyReminder();
      maybeRunDailyReminder();
      registerPeriodicSync();
    }

    registerServiceWorker();

    // Atalho do manifesto PWA: abrir o app já focado no formulário.
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'new' && state.session) {
      els.titleInput.focus();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
