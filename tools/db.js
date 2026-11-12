/**
 * TaskSchool — tools/db.js
 * Abre o banco SQLite de desenvolvimento usando o módulo nativo do Node.
 * Uso: const db = openDb(); db.exec(...); db.close();
 */
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taskschool.db');

function openDb(file = DB_PATH) {
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

module.exports = { openDb, DB_PATH };
