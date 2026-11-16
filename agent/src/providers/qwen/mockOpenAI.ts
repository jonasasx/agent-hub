// A mock of an OpenAI-compatible server (llama-server) for the tests of the Qwen provider (change qwen-provider, task 4):
// GET /v1/models and POST /v1/chat/completions with tool calling, streamed or not. The answer depends on the last
// message of the request: a tool result → a final text, a user text with «TOOL <command>» → a call of the shell tool, «WRITE <path>» → a call of write_file (asks for permission),
// «SLOW» → a long stream that the test can interrupt, «FAIL401» → HTTP 401, anything else → «pong: <text>».
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

export interface MockOpenAI {
  baseUrl: string;
  apiKey: string;
  models: string[];
  requests: MockRequest[];
  /** Status of /models for the next requests (default 200). */
  modelsStatus: number;
  close(): Promise<void>;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

/** The text of a message without the <system-reminder> blocks the CLI adds. */
function textOf(content: unknown): string {
  const raw =
    typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : '')).join(' ') : '';
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sse(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): Record<string, unknown> {
  return { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

const USAGE = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };

export async function startMockOpenAI(o: { apiKey?: string; models?: string[] } = {}): Promise<MockOpenAI> {
  const apiKey = o.apiKey ?? 'mock-key-0123456789';
  const mock: MockOpenAI = { baseUrl: '', apiKey, models: o.models ?? ['qwen3.8-flash-next'], requests: [], modelsStatus: 200, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let body: Record<string, unknown> | null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      mock.requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        if (mock.modelsStatus !== 200) {
          res.writeHead(mock.modelsStatus, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: mock.models.map(id => ({ id, object: 'model' })) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions' && body) {
        await chat(res, body);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  async function chat(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const messages = (body.messages as ChatMessage[] | undefined) ?? [];
    const last = messages[messages.length - 1];
    const userText = textOf([...messages].reverse().find(m => m.role === 'user')?.content);
    const stream = body.stream === true;
    let toolCall: { name: string; args: string } | null = null;
    let text = '';
    let slow = false;
    if (last?.role === 'tool') {
      text = `Done: ${textOf(last.content).trim().slice(0, 200)}`;
    } else if (/FAIL401/.test(userText)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
      return;
    } else if (/SLOW/.test(userText)) {
      slow = true;
      text = 'working';
    } else if (/WRITE /.test(userText)) {
      const file = userText.slice(userText.indexOf('WRITE ') + 6).trim();
      toolCall = { name: 'write_file', args: JSON.stringify({ file_path: file, content: 'written by the mock' }) };
    } else if (/TOOL /.test(userText)) {
      const command = userText.slice(userText.indexOf('TOOL ') + 5).trim();
      toolCall = { name: 'run_shell_command', args: JSON.stringify({ command, is_background: false, description: 'mock' }) };
    } else {
      text = `pong: ${userText.trim().slice(0, 200)}`;
    }
    if (!stream) {
      const message = toolCall
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }
        : { role: 'assistant', content: text };
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1,
          model: 'mock',
          choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
          usage: USAGE,
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sse(res, chunk({ role: 'assistant', content: '' }));
    if (toolCall) {
      sse(res, chunk({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }));
      sse(res, chunk({}, 'tool_calls', USAGE));
      res.end('data: [DONE]\n\n');
      return;
    }
    const parts = text.match(/.{1,6}/g) ?? [text];
    for (const p of parts) sse(res, chunk({ content: p }));
    if (slow) {
      // keeps the stream open until the client goes away (an interrupted turn)
      const timer = setInterval(() => sse(res, chunk({ content: '.' })), 200);
      res.on('close', () => clearInterval(timer));
      return;
    }
    sse(res, chunk({}, 'stop', USAGE));
    res.end('data: [DONE]\n\n');
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return mock;
}
