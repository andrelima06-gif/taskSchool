/**
 * Limpa os dados criados pelos testes, deixando o banco como estava.
 * Uso: node tools/clean-test-data.js
 */
'use strict';

const path = require('path');
const { openDb } = require('./db');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taskschool.db');

const db = openDb(DB_PATH);

const antes = {
  alunos: db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
  tarefas: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
};

const alvos = db
  .prepare(
    `SELECT id, name FROM students
      WHERE name LIKE '%E2E%'
         OR name IN ('Maria Silva', 'Joao Souza', 'Teste Silva')`
  )
  .all();

const delT = db.prepare('DELETE FROM tasks WHERE studentId = ?');
const delS = db.prepare('DELETE FROM students WHERE id = ?');
db.transaction(() => alvos.forEach((a) => { delT.run(a.id); delS.run(a.id); }))();

db.prepare(
  `DELETE FROM tasks
    WHERE title LIKE '%E2E%'
       OR title LIKE 'Tarefa do Joao%'
       OR title LIKE 'Tarefa criada OFFLINE%'
       OR title IN ('Sem prioridade', 'Tarefa E2E automatizada', 'Tarefa E2E EDITADA')`
).run();

const depois = {
  alunos: db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
  tarefas: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
};

console.log('Alunos removidos :', alvos.map((a) => a.name).join(', ') || '(nenhum)');
console.log(`Antes  : ${antes.alunos} alunos / ${antes.tarefas} tarefas`);
console.log(`Depois : ${depois.alunos} alunos / ${depois.tarefas} tarefas`);
console.log('Alunos restantes:', JSON.stringify(db.prepare('SELECT name, classKey FROM students').all()));
console.log('Tarefas restantes:', JSON.stringify(db.prepare('SELECT title FROM tasks').all()));

db.close();
