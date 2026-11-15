const NETWORK_MESSAGE = 'Could not reach the server. Please try again.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 0);
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && data.error && typeof data.error.message === 'string' ? data.error.message : GENERIC_MESSAGE;
    throw new ApiError(message, res.status);
  }
  if (data === null) throw new ApiError(GENERIC_MESSAGE, res.status);
  return data;
}

export const api = {
  list: () => request('GET', '/api/todos'),
  create: (title) => request('POST', '/api/todos', { title }),
  update: (id, fields) => request('PATCH', `/api/todos/${id}`, fields),
  remove: (id) => request('DELETE', `/api/todos/${id}`),
};
