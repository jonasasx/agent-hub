// Task 1.3: proves that the Agent SDK works from the process context the agent runs in
// (Windows Task Scheduler S4U, systemd). Runs one query() under the user's Claude subscription
// (~/.claude credentials) in the given directory and writes the result as JSON.
//
//   node s4u-check.mjs --cwd C:\Users\me\vault --out C:\Users\me\.agent-hub\s4u-check.json
//
// Exit code 0 only if the model answered with the expected marker.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';

const { values } = parseArgs({ options: { cwd: { type: 'string' }, out: { type: 'string' }, model: { type: 'string' } } });
const cwd = values.cwd ?? process.cwd();
const out = values.out ?? 's4u-check.json';
const MARKER = 'S4U-OK';
const started = Date.now();

const report = {
  startedAt: new Date(started).toISOString(),
  user: os.userInfo().username,
  hostname: os.hostname(),
  home: os.homedir(),
  userProfile: process.env.USERPROFILE ?? null,
  sessionName: process.env.SESSIONNAME ?? null,
  cwd,
  node: process.version,
  ok: false,
  answer: null,
  sessionId: null,
  model: null,
  apiKeySource: null,
  durationMs: null,
  error: null,
};

function save() {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}

try {
  const q = query({
    prompt: `Reply with exactly ${MARKER} and nothing else.`,
    options: {
      cwd,
      model: values.model ?? 'haiku',
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      permissionMode: 'default',
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      report.model = m.model ?? null;
      report.apiKeySource = m.apiKeySource ?? null;
      report.sessionId = m.session_id ?? null;
    }
    if (m.type === 'result') {
      report.durationMs = Date.now() - started;
      if (m.subtype === 'success') {
        report.answer = m.result;
        report.ok = typeof m.result === 'string' && m.result.includes(MARKER);
      } else {
        report.error = `${m.subtype}: ${JSON.stringify(m.errors ?? null)}`;
      }
    }
  }
} catch (err) {
  report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
report.durationMs ??= Date.now() - started;
save();
process.exit(report.ok ? 0 : 1);
