import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../frontend/dist');
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_PATH = process.env.DATABASE_PATH || './data/todos.db';
const MAX_TITLE = 200;

const db = openDb(DATABASE_PATH);
const app = express();

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const validation = (message) => new ApiError(400, 'VALIDATION_ERROR', message);
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Todo not found');

function parseTitle(value) {
  if (typeof value !== 'string') throw validation('title must be a string');
  const title = value.trim();
  const length = [...title].length;
  if (length === 0) throw validation('title must not be empty');
  if (length > MAX_TITLE) throw validation(`title must be at most ${MAX_TITLE} characters`);
  return title;
}

function parseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validation('Request body must be a JSON object');
  }
  return body;
}

function findTodo(rawId) {
  if (!/^[1-9]\d{0,15}$/.test(rawId)) throw notFound();
  const todo = db.get(Number(rawId));
  if (!todo) throw notFound();
  return todo;
}

const api = express.Router();
api.use(express.json());

api.get('/todos', (req, res) => {
  res.json(db.list());
});

api.post('/todos', (req, res) => {
  const body = parseBody(req.body);
  const title = parseTitle(body.title);
  res.status(201).json(db.create(title));
});

api.patch('/todos/:id', (req, res) => {
  const todo = findTodo(req.params.id);
  const body = parseBody(req.body);
  const fields = {};
  if (body.title !== undefined) fields.title = parseTitle(body.title);
  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') throw validation('completed must be a boolean');
    fields.completed = body.completed;
  }
  if (fields.title === undefined && fields.completed === undefined) {
    throw validation('Provide at least one of title or completed');
  }
  res.json(db.update(todo.id, fields));
});

api.delete('/todos/:id', (req, res) => {
  const todo = findTodo(req.params.id);
  db.remove(todo.id);
  res.status(204).end();
});

api.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.status >= 400 && err.status < 500) {
    // body-parser errors: malformed JSON, payload too large, unsupported charset, ...
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body';
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

app.use('/api', api);
app.use(express.static(distDir));
app.use((req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
