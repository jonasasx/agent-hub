// The text of a notification (D3): pure functions, secrets cut, spaces collapsed, the budget of PUSH_BODY_MAX.
import { PUSH_BODY_MAX } from '@agent-hub/shared';
import { redactSecrets } from '../projects/haiku.js';
import { permissionKind, questionsOf } from '../sessions/repo.js';

export type TextOf = (key: string, params?: Record<string, string | number>) => string;

const BODY_SEPARATOR = ' · ';
const TARGET_MAX = 80;
const TARGET_FIELDS = ['command', 'file_path', 'path', 'url', 'pattern', 'description'];

/** A plain one-line piece of `text`: no secrets, fences or markdown markers; the `head` or the `tail` when it is longer than `max`. */
export function snippet(text: string, max: number, from: 'head' | 'tail'): string {
  const plain = redactSecrets(text)
    .replace(/```\w*/g, ' ')
    .replace(/^[\s`*#>]+/gm, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  if (max <= 1) return '…'.slice(0, max);
  return from === 'head' ? `${plain.slice(0, max - 1)}…` : `…${plain.slice(-(max - 1))}`;
}

/** «machine · text» within PUSH_BODY_MAX: the text gets what the machine name and the separator leave. */
export function composeBody(machine: string, text: string, from: 'head' | 'tail'): string {
  const name = snippet(machine, 30, 'head');
  const head = `${name}${BODY_SEPARATOR}`;
  const room = PUSH_BODY_MAX - head.length;
  if (!text.trim() || room < 10) return name || snippet(text, PUSH_BODY_MAX, from);
  return `${head}${snippet(text, room, from)}`;
}

/** The program of a shell command, without arguments: they hold passwords, tokens and URLs with credentials in every spelling. */
function programOf(command: string): string {
  const word = command.trim().split(/\s+/)[0] ?? '';
  return snippet(word.split(/[\\/]/).pop() ?? '', 40, 'head');
}

function targetOf(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.command === 'string') return programOf(o.command);
  for (const f of TARGET_FIELDS) {
    const v = o[f];
    if (typeof v === 'string' && v.trim()) return snippet(v, TARGET_MAX, 'head');
  }
  return '';
}

/** What an open permission request says: the question, the plan, or the tool with its target. */
export function permissionText(request: { tool_name: string; input: unknown } | undefined, t: TextOf): string {
  if (!request) return t('hub.push.bodyReply');
  const kind = permissionKind(request.tool_name);
  if (kind === 'question') {
    const q = questionsOf(request.input)[0];
    const text = snippet(q?.question || q?.header || '', PUSH_BODY_MAX, 'head');
    return text || t('hub.push.bodyReply');
  }
  if (kind === 'plan') return t('hub.push.bodyPlan');
  return t('hub.push.bodyTool', { tool: request.tool_name, target: targetOf(request.input) }).trim();
}

/** The end of the answer of a turn; no text (an old agent, an error, Codex) — the fixed phrase. */
export function turnText(resultText: string | undefined, t: TextOf): string {
  const text = resultText ? snippet(resultText, PUSH_BODY_MAX, 'tail') : '';
  return text || t('hub.push.bodyReply');
}

/** A turn refused by its subscription (agent-hub-mvp 5.2a): what the note subscription_limit / subscription_auth says. */
export type TurnFailure = { kind: 'limit'; name: string; time?: string } | { kind: 'auth'; name: string; codex: boolean };

/** The reason of a refused turn instead of the answer: «лимит подписки <имя>» / «токен подписки <имя> отклонён». */
export function failureText(f: TurnFailure, t: TextOf): string {
  const name = snippet(f.name, 40, 'head');
  if (f.kind === 'auth') return t(f.codex ? 'hub.push.bodySubAuthCodex' : 'hub.push.bodySubAuth', { name });
  return f.time ? t('hub.push.bodySubLimitReset', { name, time: f.time }) : t('hub.push.bodySubLimit', { name });
}

export function titleOf(sessionTitle: string, t: TextOf): string {
  const title = snippet(sessionTitle || '', 80, 'head') || t('hub.push.untitled');
  return t('hub.push.title', { title });
}
