/* ==========================================================================
   TaskSchool — reminder.js
   Lógica compartilhada entre a página (app.js) e o Service Worker (sw.js)
   para montar o texto do lembrete diário.
   ========================================================================== */

(function (global) {
  'use strict';

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatShortDate(iso) {
    const [year, month, day] = String(iso).split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'short',
    });
  }

  /**
   * Monta o aviso do dia a partir das tarefas da turma.
   * @param {Array} tasks  tarefas (com `title`, `dueDate` e `completed`)
   * @returns {{title: string, body: string, level: string, count: number}}
   */
  function buildReminder(tasks) {
    const today = todayISO();
    const list = Array.isArray(tasks) ? tasks : [];

    const pendentes = list.filter((t) => !t.completed);
    const vencidas = pendentes.filter((t) => t.dueDate && t.dueDate < today);
    const paraHoje = pendentes.filter((t) => t.dueDate === today);
    const proximas = pendentes
      .filter((t) => t.dueDate && t.dueDate > today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const urgente = [...vencidas, ...paraHoje];

    if (urgente.length > 0) {
      const itens = urgente
        .slice(0, 3)
        .map((t) => `• ${t.title}${t.dueDate < today ? ' (vencida)' : ''}`)
        .join('\n');
      const extra = urgente.length > 3 ? `\n+${urgente.length - 3} outra(s)` : '';
      return {
        title:
          urgente.length === 1
            ? 'Você tem 1 tarefa para entregar'
            : `Você tem ${urgente.length} tarefas para entregar`,
        body: `${itens}${extra}`,
        level: 'urgent',
        count: urgente.length,
      };
    }

    if (proximas.length > 0) {
      const proxima = proximas[0];
      return {
        title: 'Nenhuma tarefa para hoje',
        body: `Próxima: ${proxima.title} (${formatShortDate(proxima.dueDate)})`,
        level: 'upcoming',
        count: pendentes.length,
      };
    }

    if (pendentes.length > 0) {
      return {
        title: 'Nenhuma tarefa com prazo para hoje',
        body: `Você ainda tem ${pendentes.length} tarefa(s) sem prazo definido.`,
        level: 'upcoming',
        count: pendentes.length,
      };
    }

    return {
      title: 'Tudo em dia!',
      body: 'Nenhuma tarefa pendente na sua turma.',
      level: 'clear',
      count: 0,
    };
  }

  const api = { buildReminder, todayISO, formatShortDate };

  global.TaskSchoolReminder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
