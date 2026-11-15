import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const MAX_TITLE = 200;
const FILTERS = ['All', 'Active', 'Completed'];

function validateTitle(raw) {
  const title = raw.trim();
  if (title.length === 0) return { error: 'Title is required.' };
  if ([...title].length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer.` };
  return { title };
}

function TodoItem({ todo, editing, onToggle, onDelete, onStartEdit, onSave, onCancel, busy }) {
  const [draft, setDraft] = useState(todo.title);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) {
      setDraft(todo.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, todo.title]);

  if (editing) {
    return (
      <li className="todo-item editing">
        <form
          className="edit-form"
          style={{ display: 'contents' }}
          onSubmit={(e) => {
            e.preventDefault();
            onSave(todo, draft);
          }}
        >
          <input
            ref={inputRef}
            className="text-input edit-input"
            aria-label="Edit title"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel(todo);
              }
            }}
            disabled={busy}
          />
          <div className="actions">
            <button type="submit" className="btn btn-save" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => onCancel(todo)}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={todo.completed ? 'todo-item completed' : 'todo-item'}>
      <input
        type="checkbox"
        className="toggle"
        aria-label={`Toggle ${todo.title}`}
        checked={todo.completed}
        onChange={() => onToggle(todo)}
      />
      <span className="todo-title">{todo.title}</span>
      <div className="actions">
        <button
          type="button"
          className="btn"
          data-edit-id={todo.id}
          aria-label={`Edit ${todo.title}`}
          onClick={() => onStartEdit(todo)}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-danger"
          aria-label={`Delete ${todo.title}`}
          onClick={() => onDelete(todo)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export default function App() {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('All');
  const [newTitle, setNewTitle] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const focusEditRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.list();
      setTodos(list);
      setLoadFailed(false);
      setError('');
    } catch (err) {
      setLoadFailed(true);
      setError(`Could not load todos. ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Return focus to the item's Edit button after leaving edit mode.
  useEffect(() => {
    if (editingId === null && focusEditRef.current !== null) {
      document.querySelector(`[data-edit-id="${focusEditRef.current}"]`)?.focus();
      focusEditRef.current = null;
    }
  }, [editingId]);

  // Runs a server mutation; local state only changes after the server confirms it.
  async function mutate(fn) {
    setBusy(true);
    try {
      await fn();
      setError('');
      if (loadFailed) await load();
      return true;
    } catch (err) {
      setError(err.message);
      if (err.status === 404) {
        // The todo no longer exists on the server: resynchronise.
        try {
          setTodos(await api.list());
        } catch {
          /* keep current state */
        }
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const { title, error: validationError } = validateTitle(newTitle);
    if (validationError) {
      setError(validationError);
      return;
    }
    await mutate(async () => {
      const created = await api.create(title);
      setTodos((prev) => [...prev, created]);
      setNewTitle('');
    });
  }

  function replaceTodo(updated) {
    setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  // Toggling is optimistic (the checkbox flips immediately) and reverted if the server rejects it.
  async function handleToggle(todo) {
    const completed = !todo.completed;
    replaceTodo({ ...todo, completed });
    const ok = await mutate(async () => replaceTodo(await api.update(todo.id, { completed })));
    if (!ok) {
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, completed: todo.completed } : t)));
    }
  }

  const handleDelete = (todo) =>
    mutate(async () => {
      await api.remove(todo.id);
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
      if (editingId === todo.id) setEditingId(null);
    });

  async function handleSave(todo, draft) {
    const { title, error: validationError } = validateTitle(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (title === todo.title) {
      setError('');
      focusEditRef.current = todo.id;
      setEditingId(null);
      return;
    }
    const ok = await mutate(async () => replaceTodo(await api.update(todo.id, { title })));
    if (ok) {
      focusEditRef.current = todo.id;
      setEditingId(null);
    }
  }

  function handleCancel(todo) {
    focusEditRef.current = todo.id;
    setEditingId(null);
  }

  const activeCount = todos.filter((t) => !t.completed).length;
  const visible = todos.filter((t) =>
    filter === 'Active' ? !t.completed : filter === 'Completed' ? t.completed : true,
  );

  return (
    <main className="app">
      <h1>Todos</h1>
      <div className="card">
        <form className="new-todo" onSubmit={handleCreate} noValidate>
          <label htmlFor="new-todo-input" className="sr-only">
            New todo
          </label>
          <input
            id="new-todo-input"
            className="text-input"
            placeholder="What needs to be done?"
            autoComplete="off"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            Add
          </button>
        </form>

        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            {loadFailed && !loading && (
              <button type="button" className="alert-action" onClick={load}>
                Retry
              </button>
            )}
          </div>
        )}

        {loading ? (
          <p className="message" role="status">
            Loading…
          </p>
        ) : loadFailed ? null : (
          <>
            <ul className="todo-list" aria-label="Todo list">
              {visible.map((todo) => (
                <TodoItem
                  key={todo.id}
                  todo={todo}
                  editing={editingId === todo.id}
                  busy={busy}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onStartEdit={(t) => {
                    setError('');
                    setEditingId(t.id);
                  }}
                  onSave={handleSave}
                  onCancel={handleCancel}
                />
              ))}
            </ul>
            {visible.length === 0 && <p className="message">No todos</p>}
          </>
        )}

        <div className="footer">
          <span className="count">
            {activeCount} {activeCount === 1 ? 'item' : 'items'} left
          </span>
          <div className="filters" role="group" aria-label="Filter todos">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className="filter"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
