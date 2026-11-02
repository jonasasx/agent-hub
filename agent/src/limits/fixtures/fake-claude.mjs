// A stand-in for the Claude Code CLI (stream-json over stdio) for probe.sdk.test.ts: answers the SDK's control requests
// and one user turn with the rate_limit_event of the spike, an assistant message and a result. FAKE_CLAUDE_MODE:
// `ok` (event + success), `hang` (never answers the turn), `limit` (rejected event + 429 + error result, then exit 1 as
// the real CLI: the SDK throws «Claude Code returned an error result» after the result), `auth` (401 + error result, exit 1). FAKE_CLAUDE_PID_FILE gets «pid\nargv as JSON».
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
if (process.env.FAKE_CLAUDE_PID_FILE)
  writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, `${process.pid}\n${JSON.stringify(process.argv.slice(2))}\n${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'token-in-env' : 'no-token'}`);
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
const sid = '00000000-0000-4000-8000-0000000000aa';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_request') {
    const response = m.request?.subtype === 'initialize' ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type !== 'user' || mode === 'hang') return;
  out({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    uuid: uuid(),
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: 'haiku',
    permissionMode: 'default',
    slash_commands: [],
    apiKeySource: 'none',
    output_style: 'default',
    skills: [],
    plugins: [],
  });
  if (mode === 'limit' || mode === 'auth') {
    const limit = mode === 'limit';
    const text = limit ? "You've hit your weekly limit · resets Oct 29, 12pm (Europe/Moscow)" : 'Invalid API key · Please run /login';
    if (limit) {
      out({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1793264400,
          rateLimitType: 'seven_day',
          overageStatus: 'rejected',
          unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: 1793121000, status: 'allowed_warning' }, seven_day: { utilization: 1, resetsAt: 1793264400, status: 'rejected' } },
        },
        uuid: uuid(),
        session_id: sid,
      });
    }
    out({
      type: 'assistant',
      error: limit ? 'rate_limit' : 'authentication_failed',
      parent_tool_use_id: null,
      session_id: sid,
      uuid: uuid(),
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: text,
      api_error_status: limit ? 429 : 401,
      duration_ms: 5,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      session_id: sid,
      uuid: uuid(),
    };
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(1));
    return;
  }
  out({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1793671200,
      rateLimitType: 'seven_day',
      utilization: 0.34,
      unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: 1793124000, status: 'allowed' }, seven_day: { utilization: 0.34, resetsAt: 1793671200, status: 'allowed' } },
    },
    uuid: uuid(),
    session_id: sid,
  });
  out({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: sid,
    uuid: uuid(),
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'haiku', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } },
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    session_id: sid,
    uuid: uuid(),
  });
});
rl.on('close', () => process.exit(0));
