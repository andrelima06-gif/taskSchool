/* ==========================================================================
   TaskSchool — sw.js (Service Worker)
   Estratégia:
     - Navegação (HTML) ....... network-first  (fallback: cache)
     - Arquivos estáticos ..... network-first  (fallback: cache)
     - API GET ............... network-first  (fallback: cache -> 503 JSON)
     - API de escrita ........ nunca é cacheada (são tratados pela fila do app)
     - Notificações .......... lembrete diário (timer no app + periodic sync)
   ========================================================================== */

// Lógica de montagem do lembrete compartilhada com a página.
importScripts('/reminder.js');

const VERSION = 'v1.2.1';
const STATIC_CACHE = `taskschool-static-${VERSION}`;
const RUNTIME_CACHE = `taskschool-runtime-${VERSION}`;
const DATA_CACHE = `taskschool-data-${VERSION}`;
const CONTEXT_CACHE = `taskschool-context-${VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/reminder.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/favicon.svg',
];

const OFFLINE_MESSAGE = JSON.stringify({
  error: { message: 'Você está offline e este recurso ainda não foi salvo em cache.' },
});

const NOTIFICATION_TAG = 'taskschool-daily';

/* ---------- Instalação: pré-cache do app shell ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // addAll falha inteiro se um recurso falhar: usa add individual.
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })()
  );
});

/* ---------- Ativação: limpeza de caches antigos ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const valid = [STATIC_CACHE, RUNTIME_CACHE, DATA_CACHE, CONTEXT_CACHE];
      await Promise.all(keys.filter((key) => !valid.includes(key)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

/* ---------- Mensagens do front-end ---------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'SET_CONTEXT' && data.classKey) {
    event.waitUntil(saveContext({ classKey: data.classKey, name: data.name || '' }));
  }

  if (data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(showNotification(data.title, data.body, data));
  }
});

/* ==========================================================================
   Notificações
   ========================================================================== */

async function saveContext(context) {
  const cache = await caches.open(CONTEXT_CACHE);
  await cache.put(
    '/__context',
    new Response(JSON.stringify(context), { headers: { 'Content-Type': 'application/json' } })
  );
}

async function readContext() {
  const cache = await caches.open(CONTEXT_CACHE);
  const response = await cache.match('/__context');
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Exibe a notificação do sistema (com ações de atalho). */
async function showNotification(title, body, options = {}) {
  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: options.tag || NOTIFICATION_TAG,
    renotify: true,
    requireInteraction: false,
    vibrate: [120, 60, 120],
    data: { url: options.url || '/' },
    actions: [
      { action: 'open', title: 'Ver tarefas' },
      { action: 'dismiss', title: 'Dispensar' },
    ],
  });
}

/** Monta o aviso a partir da lista de tarefas da turma. */
function buildReminder(tasks) {
  return self.TaskSchoolReminder.buildReminder(tasks);
}

/**
 * Verifica a lista da turma e dispara o aviso.
 * Chamado pelo app (timer) e pelo periodicsync (app fechado).
 */
async function checkAndNotify(options = {}) {
  const context = await readContext();
  if (!context || !context.classKey) return null;

  let tasks;
  try {
    const response = await fetch(`/api/tasks?classKey=${encodeURIComponent(context.classKey)}`);
    if (!response.ok) return null;
    tasks = await response.json();
  } catch {
    return null; // sem rede: tenta de novo no próximo ciclo
  }

  if (!Array.isArray(tasks)) return null;

  const reminder = buildReminder(tasks);
  if (reminder.level === 'clear' && !options.force) return reminder;

  await showNotification(reminder.title, reminder.body, { url: '/' });
  return reminder;
}

/* ---------- Sincronização periódica (app fechado) ---------- */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === NOTIFICATION_TAG) {
    event.waitUntil(checkAndNotify());
  }
});

/* ---------- Clique na notificação ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if ('focus' in client) {
          await client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })()
  );
});

self.addEventListener('notificationclose', () => {
  // Nada a fazer: o app reavalia a lista ao ser aberto.
});

/* ---------- Estratégias de fetch ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PUT/PATCH/DELETE vão direto à rede.

  const url = new URL(request.url);

  // Ignora esquemas não-HTTP (ex.: extensões do navegador).
  if (url.origin !== self.location.origin) return;

  // API REST
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, DATA_CACHE, OFFLINE_MESSAGE));
    return;
  }

  // Navegação: entrega o index.html do app shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // cache:'reload' ignora o cache HTTP do navegador: garante a versão atual.
          const fresh = new Request(request, { cache: 'reload' });
          const response = await fetch(fresh);
          const cache = await caches.open(STATIC_CACHE);
          cache.put('/index.html', response.clone());
          return response;
        } catch {
          const cached = (await caches.match('/index.html')) || (await caches.match('/'));
          return (
            cached ||
            new Response('<h1>Offline</h1><p>TaskSchool ainda não foi aberto neste dispositivo.</p>', {
              status: 503,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
          );
        }
      })()
    );
    return;
  }

  // Demais recursos estáticos: network-first (sempre a versão mais recente
  // quando online) com fallback para o cache quando offline.
  event.respondWith(networkFirst(request, RUNTIME_CACHE, ''));
});

/* ---------- Funções auxiliares ---------- */

async function networkFirst(request, cacheName, offlineBody) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(new Request(request, { cache: 'reload' }));
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(offlineBody, {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
