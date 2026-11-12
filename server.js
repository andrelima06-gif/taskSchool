'use strict';

/**
 * TaskSchool - API RESTful + servidor de arquivos estáticos (PWA)
 * Node.js + Express + SQLite (módulo nativo node:sqlite)
 *
 * Sistema de cadastro por nome + turma:
 *   - 6º, 7º, 8º e 9º ano .............. turmas A, B e C
 *   - 1º, 2º e 3º ano do EM ........... turmas A, B e C
 *   - 1º ano do EM ..................... inclui também as turmas DSB e ADM
 *
 * As tarefas são compartilhadas por turma: todos os alunos cadastrados na
 * mesma turma enxergam o mesmo quadro de tarefas.
 *
 * Variáveis de ambiente (opcionais):
 *   PORT            -> porta HTTP (padrão: 3000)
 *   DATABASE_PATH   -> caminho do arquivo SQLite (padrão: ./data/taskschool.db)
 *   SEED_DEMO       -> "false" desliga o populate inicial (padrão: popular)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

/**
 * Banco de dados: usa o módulo nativo do Node (`node:sqlite`), sem nenhuma
 * dependência nativa externa — assim o `npm install` nunca precisa de
 * compilador e funciona em qualquer ambiente (Render, CI, produção...).
 */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error(
    '\n[erro] TaskSchool usa o módulo nativo "node:sqlite".\n' +
      `        Node detectado: ${process.version}\n` +
      '        Use o Node.js 24+ ou rode com: node --experimental-sqlite server.js\n'
  );
  process.exit(1);
}

/**
 * Adaptador minimalista sobre `node:sqlite`, com a interface usada no projeto:
 * exec / prepare / transaction / close.
 */
function openDatabase(file) {
  const db = new DatabaseSync(file);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) =>
      (...args) => {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw error;
        }
      },
    close: () => db.close(),
  };
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'taskschool.db');

/* ------------------------------------------------------------------ */
/* Séries e turmas                                                     */
/* ------------------------------------------------------------------ */

const GRADES = [
  { id: '6ano', label: '6º ano', shortLabel: '6º ano', classes: ['A', 'B', 'C'] },
  { id: '7ano', label: '7º ano', shortLabel: '7º ano', classes: ['A', 'B', 'C'] },
  { id: '8ano', label: '8º ano', shortLabel: '8º ano', classes: ['A', 'B', 'C'] },
  { id: '9ano', label: '9º ano', shortLabel: '9º ano', classes: ['A', 'B', 'C'] },
  { id: '1em', label: '1º ano do Ensino Médio', shortLabel: '1º EM', classes: ['A', 'B', 'C', 'DSB', 'ADM'] },
  { id: '2em', label: '2º ano do Ensino Médio', shortLabel: '2º EM', classes: ['A', 'B', 'C'] },
  { id: '3em', label: '3º ano do Ensino Médio', shortLabel: '3º EM', classes: ['A', 'B', 'C'] },
];

const findGrade = (id) => GRADES.find((g) => g.id === id);
const buildClassKey = (gradeId, className) => `${gradeId}-${className}`;

/** Rótulo legível de uma turma (ex.: "1º EM - DSB"). */
function classLabel(classKey) {
  if (!classKey) return 'Geral';
  const [gradeId, className] = String(classKey).split('-');
  const grade = findGrade(gradeId);
  return `${grade ? grade.shortLabel : gradeId} - ${className}`;
}

/* ------------------------------------------------------------------ */
/* Banco de dados                                                      */
/* ------------------------------------------------------------------ */

/** Schema da tabela `students` (fonte única de verdade). */
const STUDENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS students (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    grade     TEXT    NOT NULL,
    className TEXT    NOT NULL,
    classKey  TEXT    NOT NULL,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Schema da tabela `tasks` (fonte única de verdade). */
const TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT    NOT NULL,
    subject   TEXT    NOT NULL DEFAULT 'Geral',
    dueDate   TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    studentId INTEGER REFERENCES students(id) ON DELETE SET NULL
  );
`;

/** Garante (ou cria) o aluno usado pelos dados de demonstração. */
function ensureDemoStudent(db) {
  const existing = db.prepare("SELECT * FROM students WHERE name = 'Aluno Demo'").get();
  if (existing) return existing;

  const info = db
    .prepare('INSERT INTO students (name, grade, className, classKey) VALUES (?, ?, ?, ?)')
    .run('Aluno Demo', '6ano', 'A', '6ano-A');

  return db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Migra bancos criados por versões anteriores:
 *  - adiciona a coluna `studentId` em `tasks`;
 *  - cria a tabela `students`;
 *  - vincula as tarefas antigas (sem autor) ao aluno demo, preservando os dados.
 */
function migrateSchema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  if (tables.includes('tasks')) {
    const columns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!columns.includes('studentId')) {
      db.exec('ALTER TABLE tasks ADD COLUMN studentId INTEGER REFERENCES students(id) ON DELETE SET NULL');
      console.log('[db] Migração: coluna "studentId" adicionada em "tasks".');
    }
  }

  db.exec(STUDENTS_SCHEMA);

  if (!tables.includes('tasks')) return;

  const orphans = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE studentId IS NULL').get().c;
  if (orphans > 0) {
    const demo = ensureDemoStudent(db);
    db.prepare('UPDATE tasks SET studentId = ? WHERE studentId IS NULL').run(demo.id);
    console.log(`[db] Migração: ${orphans} tarefa(s) sem autor vinculada(s) ao aluno demo.`);
  }
}

/** Cria o banco e as tabelas automaticamente caso ainda não existam. */
function initDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = openDatabase(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();

  migrateSchema(db);

  db.exec(TASKS_SCHEMA);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks (completed);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks (dueDate);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_students_class  ON students (classKey);`);

  // Popula o banco apenas quando não há nenhuma tarefa.
  const total = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  if (total === 0 && process.env.SEED_DEMO !== 'false') {
    seedDatabase(db);
  }

  return db;
}

function seedDatabase(db) {
  const demo = ensureDemoStudent(db);

  const insert = db.prepare(`
    INSERT INTO tasks (title, subject, dueDate, completed, studentId)
    VALUES (@title, @subject, @dueDate, @completed, @studentId)
  `);

  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plusDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return iso(d);
  };

  const samples = [
    { title: 'Revisar matéria de Biologia', subject: 'Biologia', dueDate: plusDays(1), completed: 0, studentId: demo.id },
    { title: 'Resolver exercícios de Álgebra', subject: 'Matemática', dueDate: plusDays(2), completed: 0, studentId: demo.id },
    { title: 'Ler capítulo 4 - Guerras Mundiais', subject: 'História', dueDate: plusDays(3), completed: 0, studentId: demo.id },
    { title: 'Fazer resumo de Química', subject: 'Química', dueDate: plusDays(-1), completed: 0, studentId: demo.id },
    { title: 'Assistir aula de Literatura', subject: 'Português', dueDate: plusDays(-2), completed: 1, studentId: demo.id },
  ];

  const seed = db.transaction((rows) => rows.forEach((row) => insert.run(row)));
  seed(samples);
  console.log(`[db] ${samples.length} tarefas de exemplo inseridas para a turma 6ano-A.`);
}

const db = initDatabase();

/* ------------------------------------------------------------------ */
/* Middlewares                                                         */
/* ------------------------------------------------------------------ */

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// Log simples de requisições (sem poluir o console do Render).
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
  }
  next();
});

/* ------------------------------------------------------------------ */
/* Validação                                                           */
/* ------------------------------------------------------------------ */

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sanitizeText(value, field, { required = false, maxLength = 120, fallback = '' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HttpError(400, `O campo "${field}" é obrigatório.`);
    }
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `O campo "${field}" deve ser texto.`);
  }
  const clean = value.trim();
  if (required && clean.length === 0) {
    throw new HttpError(400, `O campo "${field}" é obrigatório.`);
  }
  if (clean.length > maxLength) {
    throw new HttpError(400, `O campo "${field}" deve ter no máximo ${maxLength} caracteres.`);
  }
  return clean;
}

function sanitizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_REGEX.test(value.trim())) {
    throw new HttpError(400, 'O campo "dueDate" deve estar no formato YYYY-MM-DD.');
  }
  return value.trim();
}

function sanitizeCompleted(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 1 || value === 0 || value === '1' || value === '0') return Number(value);
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    if (['true', '1', 'sim', 'yes'].includes(normalized)) return 1;
    if (['false', '0', 'nao', 'não', 'no'].includes(normalized)) return 0;
  }
  throw new HttpError(400, 'O campo "completed" deve ser booleano (true/false).');
}

/** Valida e converte o id recebido na URL. */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'ID inválido.');
  return id;
}

/**
 * O campo `priority` foi removido do modelo de dados.
 * Se um cliente antigo ainda enviar o campo, devolvemos um erro claro.
 */
function rejectRemovedFields(body) {
  if (
    body &&
    typeof body === 'object' &&
    'priority' in body &&
    body.priority !== undefined &&
    body.priority !== null &&
    body.priority !== ''
  ) {
    throw new HttpError(
      400,
      'O campo "priority" foi removido. Envie apenas: title, subject, dueDate e completed.'
    );
  }
}

/** Normaliza o payload de cadastro (nome + série + turma). */
function parseStudentPayload(body) {
  const payload = body && typeof body === 'object' ? body : {};

  const name = sanitizeText(payload.name, 'name', { required: true, maxLength: 60 });
  if (name.length < 2) {
    throw new HttpError(400, 'Informe um nome com pelo menos 2 caracteres.');
  }

  const gradeId = sanitizeText(payload.grade, 'grade', { required: true, maxLength: 20 });
  const grade = findGrade(gradeId);
  if (!grade) {
    throw new HttpError(400, `Série inválida. Use uma de: ${GRADES.map((g) => g.id).join(', ')}.`);
  }

  const className = sanitizeText(payload.className, 'className', { required: true, maxLength: 10 }).toUpperCase();
  if (!grade.classes.includes(className)) {
    throw new HttpError(400, `A turma "${className}" não existe para ${grade.label}. Use: ${grade.classes.join(', ')}.`);
  }

  return { name, grade: grade.id, className, classKey: buildClassKey(grade.id, className) };
}

/** Normaliza o payload recebido no corpo da requisição de tarefa. */
function parseTaskPayload(body, { partial = false } = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const task = {};

  if (!partial || 'title' in payload) {
    task.title = sanitizeText(payload.title, 'title', { required: true, maxLength: 120 });
  }
  if (!partial || 'subject' in payload) {
    task.subject = sanitizeText(payload.subject, 'subject', { maxLength: 60, fallback: 'Geral' }) || 'Geral';
  }
  if (!partial || 'dueDate' in payload) {
    task.dueDate = sanitizeDate(payload.dueDate);
  }
  if (!partial || 'completed' in payload) {
    task.completed = sanitizeCompleted(payload.completed);
  }

  return task;
}

/* ------------------------------------------------------------------ */
/* Repositório (camada de acesso ao SQLite)                            */
/* ------------------------------------------------------------------ */

const studentsRepo = {
  create({ name, grade, className, classKey }) {
    // Mesmo nome na mesma turma = mesmo aluno (entrar de novo não duplica).
    const existing = db
      .prepare('SELECT * FROM students WHERE classKey = ? AND lower(name) = lower(?)')
      .get(classKey, name);
    if (existing) return { student: existing, created: false };

    const info = db
      .prepare('INSERT INTO students (name, grade, className, classKey) VALUES (?, ?, ?, ?)')
      .run(name, grade, className, classKey);

    return {
      student: db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid),
      created: true,
    };
  },

  findById(id) {
    return db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  },

  listByClass(classKey) {
    return db
      .prepare('SELECT * FROM students WHERE classKey = ? ORDER BY lower(name) ASC')
      .all(classKey);
  },

  classes() {
    return db
      .prepare(
        `SELECT classKey, grade, className, COUNT(*) AS students
           FROM students
          GROUP BY classKey
          ORDER BY grade ASC, className ASC`
      )
      .all()
      .map((row) => ({ ...row, label: classLabel(row.classKey) }));
  },
};

const tasksRepo = {
  list({ completed, subject, search, classKey } = {}) {
    let sql = `SELECT t.*, s.name AS authorName, s.grade AS authorGrade, s.className AS authorClass
                 FROM tasks t
                 LEFT JOIN students s ON s.id = t.studentId
                WHERE 1 = 1`;
    const params = {};

    if (classKey) {
      sql += ' AND s.classKey = @classKey';
      params.classKey = classKey;
    }
    if (completed !== undefined) {
      sql += ' AND t.completed = @completed';
      params.completed = completed;
    }
    if (subject) {
      sql += ' AND t.subject = @subject';
      params.subject = subject;
    }
    if (search) {
      sql += ' AND (t.title LIKE @search OR t.subject LIKE @search)';
      params.search = `%${search}%`;
    }
    sql += ' ORDER BY t.completed ASC, (t.dueDate IS NULL), t.dueDate ASC, t.id DESC';

    return db.prepare(sql).all(params);
  },

  findById(id) {
    return db
      .prepare(
        `SELECT t.*, s.name AS authorName, s.grade AS authorGrade, s.className AS authorClass
           FROM tasks t
           LEFT JOIN students s ON s.id = t.studentId
          WHERE t.id = ?`
      )
      .get(id);
  },

  create(task, forcedId) {
    const columns = ['title', 'subject', 'dueDate', 'completed', 'studentId'];
    const placeholders = columns.map((c) => `@${c}`);

    let sql = `INSERT INTO tasks (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
    const params = { ...task };

    if (forcedId !== undefined && forcedId !== null) {
      sql = `INSERT OR IGNORE INTO tasks (id, ${columns.join(', ')}) VALUES (@id, ${placeholders.join(', ')})`;
      params.id = forcedId;
    }

    const info = db.prepare(sql).run(params);
    const id = forcedId !== undefined && forcedId !== null ? forcedId : Number(info.lastInsertRowid);
    return this.findById(id);
  },

  update(id, task) {
    const columns = Object.keys(task);
    if (columns.length === 0) return this.findById(id);

    const assignments = columns.map((c) => `${c} = @${c}`).join(', ');
    const info = db
      .prepare(`UPDATE tasks SET ${assignments} WHERE id = @id`)
      .run({ ...task, id });

    if (info.changes === 0) return null;
    return this.findById(id);
  },

  remove(id) {
    const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return info.changes > 0;
  },

  subjects(classKey) {
    const sql = classKey
      ? `SELECT DISTINCT t.subject FROM tasks t JOIN students s ON s.id = t.studentId
          WHERE s.classKey = ? ORDER BY t.subject ASC`
      : 'SELECT DISTINCT subject FROM tasks ORDER BY subject ASC';
    const rows = classKey ? db.prepare(sql).all(classKey) : db.prepare(sql).all();
    return rows.map((r) => r.subject);
  },

  stats(classKey) {
    const scope = classKey ? 'AND s.classKey = @classKey' : '';
    const row = db
      .prepare(
        `SELECT
            COUNT(*)                                                    AS total,
            SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END)            AS completed,
            SUM(CASE WHEN t.completed = 0 THEN 1 ELSE 0 END)            AS pending,
            SUM(CASE WHEN t.completed = 0 AND t.dueDate IS NOT NULL
                      AND t.dueDate < date('now')                       THEN 1 ELSE 0 END) AS overdue
           FROM tasks t
           LEFT JOIN students s ON s.id = t.studentId
          WHERE 1 = 1 ${scope}`
      )
      .get(classKey ? { classKey } : {});

    return {
      total: row.total || 0,
      completed: row.completed || 0,
      pending: row.pending || 0,
      overdue: row.overdue || 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Rotas da API                                                        */
/* ------------------------------------------------------------------ */

const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/** Estrutura de séries e turmas (fonte única de verdade no front-end). */
api.get('/grades', (_req, res) => {
  res.json(
    GRADES.map((g) => ({
      id: g.id,
      label: g.label,
      shortLabel: g.shortLabel,
      classes: g.classes,
    }))
  );
});

/** Turmas que já têm alunos cadastrados. */
api.get('/classes', (_req, res) => {
  res.json(studentsRepo.classes());
});

/** Cadastra um aluno (ou devolve o cadastro existente, sem duplicar). */
api.post('/students', (req, res) => {
  const payload = parseStudentPayload(req.body);
  const { student, created } = studentsRepo.create(payload);
  res.status(created ? 201 : 200).json({ ...student, created, classLabel: classLabel(student.classKey) });
});

/** Lista os alunos de uma turma. */
api.get('/students', (req, res) => {
  const classKey = req.query.classKey;
  if (!classKey) throw new HttpError(400, 'Informe o parâmetro "classKey" (ex.: 6ano-A).');
  res.json(studentsRepo.listByClass(String(classKey)));
});

/** Dados de um aluno. */
api.get('/students/:id', (req, res) => {
  const id = parseId(req.params.id);
  const student = studentsRepo.findById(id);
  if (!student) throw new HttpError(404, 'Aluno não encontrado.');
  res.json({ ...student, classLabel: classLabel(student.classKey) });
});

api.get('/tasks', (req, res) => {
  const { status, subject, search, q, classKey } = req.query;
  const filters = {};

  if (status !== undefined && status !== '' && status !== 'all') {
    const normalized = String(status).toLowerCase();
    if (['pending', 'pendente', 'pendentes'].includes(normalized)) filters.completed = 0;
    else if (['completed', 'concluida', 'concluidas', 'concluído'].includes(normalized)) filters.completed = 1;
    else throw new HttpError(400, 'Filtro "status" inválido. Use: all, pending ou completed.');
  }

  if (subject) filters.subject = String(subject).trim();
  if (classKey) filters.classKey = String(classKey).trim();
  const term = (search || q || '').toString().trim();
  if (term) filters.search = term;

  res.json(tasksRepo.list(filters));
});

api.get('/tasks/:id', (req, res) => {
  const id = parseId(req.params.id);

  const task = tasksRepo.findById(id);
  if (!task) throw new HttpError(404, 'Tarefa não encontrada.');
  res.json(task);
});

api.post('/tasks', (req, res) => {
  rejectRemovedFields(req.body);
  const task = parseTaskPayload(req.body);

  // A tarefa pertence à turma de quem criou (o servidor não confia no cliente).
  const studentId = parseId(req.body ? req.body.studentId : undefined);
  const student = studentsRepo.findById(studentId);
  if (!student) {
    throw new HttpError(400, 'Aluno não encontrado. Faça o cadastro novamente para continuar.');
  }
  task.studentId = student.id;

  // Permite id definido pelo cliente (uso offline/PWA), desde que seja inteiro válido.
  let forcedId;
  if (req.body && req.body.id !== undefined && req.body.id !== null) {
    const candidate = Number(req.body.id);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new HttpError(400, 'O campo "id" deve ser um inteiro positivo válido.');
    }
    if (tasksRepo.findById(candidate)) {
      throw new HttpError(409, 'Já existe uma tarefa com este id.');
    }
    forcedId = candidate;
  }

  const created = tasksRepo.create(task, forcedId);
  res.status(201).json(created);
});

api.put('/tasks/:id', (req, res) => {
  const id = parseId(req.params.id);
  rejectRemovedFields(req.body);

  const task = parseTaskPayload(req.body, { partial: true });
  if (Object.keys(task).length === 0) {
    throw new HttpError(400, 'Envie ao menos um campo para atualizar ("title", "subject", "dueDate" ou "completed").');
  }

  const updated = tasksRepo.update(id, task);
  if (!updated) throw new HttpError(404, 'Tarefa não encontrada.');
  res.json(updated);
});

api.patch('/tasks/:id', (req, res) => {
  const id = parseId(req.params.id);
  rejectRemovedFields(req.body);

  const current = tasksRepo.findById(id);
  if (!current) throw new HttpError(404, 'Tarefa não encontrada.');

  const payload = { completed: sanitizeCompleted(req.body ? req.body.completed : undefined) };
  if (req.body && req.body.title !== undefined) payload.title = sanitizeText(req.body.title, 'title', { required: true });
  if (req.body && req.body.subject !== undefined) payload.subject = sanitizeText(req.body.subject, 'subject', { maxLength: 60 }) || 'Geral';
  if (req.body && req.body.dueDate !== undefined) payload.dueDate = sanitizeDate(req.body.dueDate);

  const updated = tasksRepo.update(id, payload);
  res.json(updated);
});

api.delete('/tasks/:id', (req, res) => {
  const id = parseId(req.params.id);

  const removed = tasksRepo.remove(id);
  if (!removed) throw new HttpError(404, 'Tarefa não encontrada.');
  res.status(204).end();
});

api.get('/stats', (req, res) => {
  const classKey = req.query.classKey ? String(req.query.classKey).trim() : undefined;
  res.json(tasksRepo.stats(classKey));
});

api.get('/subjects', (req, res) => {
  const classKey = req.query.classKey ? String(req.query.classKey).trim() : undefined;
  res.json(tasksRepo.subjects(classKey));
});

app.use('/api', api);

/* ------------------------------------------------------------------ */
/* Arquivos estáticos / PWA                                            */
/* ------------------------------------------------------------------ */

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: 0,
    setHeaders(res) {
      // Os arquivos não têm hash no nome: revalidamos sempre (304 = barato)
      // para que qualquer alteração de CSS/JS apareça imediatamente.
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Fallback SPA: qualquer rota que não seja /api devolve o index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ------------------------------------------------------------------ */
/* Tratamento de erros                                                 */
/* ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: { message: 'Recurso não encontrado.', path: req.originalUrl } });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: {
      message: err.message || 'Erro interno do servidor.',
      ...(err.details ? { details: err.details } : {}),
    },
  });
});

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

const server = app.listen(PORT, () => {
  console.log(`\n  TaskSchool rodando em http://localhost:${PORT}`);
  console.log(`  Banco de dados: ${DB_PATH}`);
  console.log(`  API: http://localhost:${PORT}/api/tasks\n`);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} recebido, encerrando...`);
  server.close(() => {
    try {
      db.close();
    } catch (err) {
      console.error('[db] erro ao fechar banco:', err);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
