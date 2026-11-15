/**
 * Fake Anthropic upstream for gateway / Claude Code tests (loopback only, no real model).
 * /v1/messages answers with a canned SSE stream (or JSON when stream !== true) whose text is
 * `replyText`; every request's method, path and headers are recorded.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export const FAKE_USAGE_START = { input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 };
export const FAKE_USAGE_DELTA = { output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } };

export function sseBody(model: string, text: string, id = 'msg_fake_1'): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: FAKE_USAGE_START } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('ping', { type: 'ping' }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: FAKE_USAGE_DELTA }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

export interface FakeAnthropic {
  url: string;
  port: number;
  requests: FakeRequest[];
  /** Override the next responses: return true when handled. */
  handler?: (req: FakeRequest, res: http.ServerResponse) => boolean;
  replyText: string;
  close(): Promise<void>;
}

export async function startFakeAnthropic(opts: { replyText?: string; chunkDelayMs?: number } = {}): Promise<FakeAnthropic> {
  const fake: FakeAnthropic = { url: '', port: 0, requests: [], replyText: opts.replyText ?? 'ok', close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r: FakeRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      fake.requests.push(r);
      if (fake.handler?.(r, res)) return;
      const p = r.path.split('?')[0];
      if (p === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 4242 }));
        return;
      }
      if (p === '/v1/messages' && r.method === 'POST') {
        let body: any = {};
        try {
          body = JSON.parse(r.body);
        } catch {
          /* ignore */
        }
        const model = body.model ?? 'claude-sonnet-5-5';
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' });
          const parts = sseBody(model, fake.replyText).split(/(?<=\n\n)/);
          for (const part of parts) {
            res.write(part);
            if (opts.chunkDelayMs) await new Promise((rs) => setTimeout(rs, opts.chunkDelayMs));
          }
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_fake_json',
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: fake.replyText }],
              stop_reason: 'end_turn',
              usage: { ...FAKE_USAGE_START, ...FAKE_USAGE_DELTA },
            }),
          );
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return fake;
}

/** SSE for an assistant turn that calls one tool. */
export function sseToolUse(model: string, toolId: string, name: string, input: Record<string, unknown>, id = `msg_fake_${toolId}`): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: FAKE_USAGE_START } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: FAKE_USAGE_DELTA }) +
    ev('message_stop', { type: 'message_stop' })
  );
}
