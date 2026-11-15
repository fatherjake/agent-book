import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);

  const toTodo = (row) =>
    row && { id: row.id, title: row.title, completed: row.completed === 1, createdAt: row.created_at };

  const stmts = {
    list: db.prepare('SELECT * FROM todos ORDER BY created_at ASC, id ASC'),
    get: db.prepare('SELECT * FROM todos WHERE id = ?'),
    insert: db.prepare('INSERT INTO todos (title, completed, created_at) VALUES (?, 0, ?)'),
    remove: db.prepare('DELETE FROM todos WHERE id = ?'),
  };

  return {
    list: () => stmts.list.all().map(toTodo),
    get: (id) => toTodo(stmts.get.get(id)),
    create(title) {
      const info = stmts.insert.run(title, new Date().toISOString());
      return toTodo(stmts.get.get(info.lastInsertRowid));
    },
    update(id, fields) {
      const sets = [];
      const values = [];
      if (fields.title !== undefined) {
        sets.push('title = ?');
        values.push(fields.title);
      }
      if (fields.completed !== undefined) {
        sets.push('completed = ?');
        values.push(fields.completed ? 1 : 0);
      }
      db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      return toTodo(stmts.get.get(id));
    },
    remove: (id) => stmts.remove.run(id).changes > 0,
  };
}
