/**
 * Turns hub events (raw `.jsonl` lines, hub notes, permission requests) into chat items.
 * Requirement: Обмен сообщениями — user messages, assistant text (Markdown), collapsed tool calls with their result,
 * file edits as a diff, system notes. design.md D11: `thinking` is hidden, `tool_use` is paired with `tool_result`
 * by `tool_use_id`, Edit/MultiEdit/Write → diff from `input` or `toolUseResult.structuredPatch`.
 * Requirement (chat-images): Изображения от агента в чате — image blocks of tool results and of user messages become
 * `images` of their item (D19); a big text result moved to S3 keeps its preview and a reference for «Показать полностью»,
 * and so does a big output Claude Code saved to tool-results (its copy on the hub, `sideFiles`).
 */
import type { HubEvent, PermissionView, SideFileRef, SubscriptionNote, TranscriptLine } from '../../api/types';
import { parsePeerMessage, type I18nText } from '@agent-hub/shared';
import { t as tr, hubText } from '../../i18n';
import { imageOfBlock, type ImageRef } from '../images/format';
import { answeredText, askKind } from './AskCards';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
}

/** A text moved to S3 (`$blob`, D4): the preview is shown, the whole text on request. */
export interface TextBlob {
  sha256: string;
  size: number;
}

/**
 * A big tool output Claude Code saved to `<session>/tool-results/<name>` (`<persisted-output>` in the result): the hub
 * keeps a copy and the line event links it (`sideFiles`, M3c contract); `size` is the one Claude Code states.
 */
export interface SideFile extends SideFileRef {
  size?: string;
}

/** «Сообщение не доставлено» with what was sent (M3c contract): «Повторить» puts it back into the composer. */
export type Undelivered = NonNullable<Extract<HubEvent, { kind: 'note' }>['undelivered']>;

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: ImageRef[]; uuid?: string }
  /** A message from a teammate or another agent (change `subagents` S6, S9): «Сообщение от <from>». */
  /** `session`: a message of another hub session (change `session-peers` D8), not of a teammate of this one. */
  | { kind: 'peer'; id: string; from: string; text: string; session?: PeerSessionRef }
  | { kind: 'assistant'; id: string; text: string; messageId?: string }
  | {
      kind: 'tool';
      id: string;
      toolUseId: string;
      name: string;
      target: string;
      input: unknown;
      result: { text: string; isError: boolean; blob?: TextBlob; side?: SideFile } | null;
      diff: DiffLine[] | null;
      images: ImageRef[];
    }
  | { kind: 'note'; id: string; text: string; i18nKey?: string; undelivered?: Undelivered; subscription?: SubscriptionNote }
  | { kind: 'permission'; id: string; request: PermissionView };

/** The sender of a hub peer message: the session to open, its title and machine as the sender saw them. */
export interface PeerSessionRef {
  id: string;
  title: string;
  machine: string;
  inReplyTo?: string;
  /** hub-subagents D6: the task of a spawned session / the hub's report of its turn. */
  kind?: 'spawn' | 'report';
}

type Block = Record<string, unknown> & { type?: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const INTERRUPTED = /^\[Request interrupted by user/;
/** The text of the hub's note «turn interrupted» as the hub sent it (Russian before it wrote English), and as the feed shows it. */
const HUB_INTERRUPTED_TEXTS = ['Ход прерван', 'Turn interrupted'];
const interruptedNote = () => tr('chat.tr.interrupted');
const HUB_INTERRUPTED_KEY = 'hub.sessions.noteInterrupted';
const isInterruptedNote = (text: string, key?: string) => key === HUB_INTERRUPTED_KEY || text === interruptedNote() || HUB_INTERRUPTED_TEXTS.includes(text);

/** A hub note in the interface language: by its `i18n` key when the hub sent one, the stored text otherwise (older notes). */
export const noteText = (ev: { text: string; i18n?: I18nText }): string => hubText(ev.text, ev.i18n);

function shortCmd(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Short target of a tool call shown next to its name: path, command, pattern… */
export function toolTarget(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return shortCmd(str(i.description) || str(i.command));
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return str(i.file_path);
    case 'NotebookEdit':
      return str(i.notebook_path);
    case 'Grep':
    case 'Glob':
      return shortCmd(`${str(i.pattern)}${i.path ? ` · ${str(i.path)}` : ''}`);
    case 'WebFetch':
      return str(i.url);
    case 'WebSearch':
      return str(i.query);
    case 'ApplyPatch': {
      // agent-providers: the file changes of Codex
      const files = Array.isArray(i.changes) ? (i.changes as Record<string, unknown>[]).map(c => str(c.path)).filter(Boolean) : [];
      return files.length > 1 ? tr('chat.tr.andMore', { first: files[0]!, count: files.length - 1 }) : (files[0] ?? '');
    }
    case 'Task':
    case 'Agent':
      return str(i.description);
    default: {
      const first = Object.values(i).find(v => typeof v === 'string' && v.length > 0);
      return shortCmd(str(first));
    }
  }
}

function linesOf(s: string): string[] {
  const parts = s.split('\n');
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts;
}

function diffFromStrings(oldS: string, newS: string): DiffLine[] {
  return [...linesOf(oldS).map(text => ({ kind: 'del' as const, text })), ...linesOf(newS).map(text => ({ kind: 'add' as const, text }))];
}

interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
}

function diffFromPatch(patch: Hunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of patch) {
    out.push({ kind: 'hunk', text: `@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@` });
    for (const l of h.lines ?? []) {
      const c = l[0];
      out.push({ kind: c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', text: l.slice(1) });
    }
  }
  return out;
}

/**
 * agent-providers: the changes of a Codex ApplyPatch — a file header per change, then its unified diff (an added file
 * may come as its plain content: every line is an addition).
 */
export function patchDiff(input: unknown): DiffLine[] {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const changes = Array.isArray(i.changes) ? (i.changes as Record<string, unknown>[]) : [];
  const out: DiffLine[] = [];
  for (const c of changes) {
    const kind = str(c.kind);
    out.push({ kind: 'hunk', text: `${kind === 'add' ? tr('chat.tr.newFile') : kind === 'delete' ? tr('chat.tr.deleted') : tr('chat.tr.changed')}: ${str(c.path)}` });
    const lines = linesOf(str(c.diff)).filter(l => !/^(---|\+\+\+) /.test(l) && !/^diff --git /.test(l) && !/^index [0-9a-f]/.test(l));
    const unified = lines.some(l => l.startsWith('@@'));
    for (const l of lines) {
      if (!unified) out.push({ kind: kind === 'delete' ? 'del' : 'add', text: l });
      else if (l.startsWith('@@')) out.push({ kind: 'hunk', text: l });
      else out.push({ kind: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx', text: l.slice(1) });
    }
  }
  return out;
}

/** Diff of an editing tool: structuredPatch from the result when present, otherwise from the call input. */
export function toolDiff(name: string, input: unknown, toolUseResult: unknown): DiffLine[] | null {
  if (name === 'ApplyPatch') return patchDiff(input);
  if (!['Edit', 'MultiEdit', 'Write'].includes(name)) return null;
  const r = (toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : {}) as Record<string, unknown>;
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) return diffFromPatch(r.structuredPatch as Hunk[]);
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Edit') return diffFromStrings(str(i.old_string), str(i.new_string));
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    return (i.edits as Record<string, unknown>[]).flatMap((e, n) => [...(n ? [{ kind: 'hunk' as const, text: '…' }] : []), ...diffFromStrings(str(e.old_string), str(e.new_string))]);
  }
  if (name === 'Write') return linesOf(str(i.content)).map(text => ({ kind: 'add' as const, text }));
  return null;
}

const isBlob = (v: unknown): v is { $blob: string; size?: number; preview?: string } => !!v && typeof v === 'object' && typeof (v as { $blob?: unknown }).$blob === 'string';

/** Text of a tool result; a text moved to S3 gives its preview and the reference to the whole text. */
function resultText(content: unknown): { text: string; blob?: TextBlob } {
  if (typeof content === 'string') return { text: content };
  if (isBlob(content)) return { text: str(content.preview), blob: { sha256: content.$blob, size: content.size ?? 0 } };
  if (!Array.isArray(content)) return { text: '' };
  let blob: TextBlob | undefined;
  const parts = content.map((b: Block) => {
    if (b.type === 'text') {
      if (isBlob(b.text)) {
        blob ??= { sha256: b.text.$blob, size: b.text.size ?? 0 };
        return str(b.text.preview);
      }
      return str(b.text);
    }
    if (isBlob(b)) {
      blob ??= { sha256: b.$blob, size: b.size ?? 0 };
      return str(b.preview);
    }
    return '';
  });
  return { text: parts.filter(Boolean).join('\n'), ...(blob ? { blob } : {}) };
}

const PERSISTED = /<persisted-output>[\s\S]*?Output too large \(([^)]+)\)/;

/** The copy of a big output this result points to: the side file whose name is in the `<persisted-output>` path. */
function sideOf(text: string, files: SideFileRef[] | undefined): SideFile | undefined {
  const m = PERSISTED.exec(text);
  if (!m || !files?.length) return undefined;
  const f = files.find(x => x.name && text.includes(x.name)) ?? (files.length === 1 ? files[0] : undefined);
  return f && { name: f.name, url: f.url, size: m[1] };
}

/** Undelivered message data of a note, when the hub sent it in the agreed shape. */
function undeliveredOf(ev: Extract<HubEvent, { kind: 'note' }>): Undelivered | undefined {
  const u: Partial<Undelivered> | undefined = ev.undelivered;
  if (!u || typeof u.text !== 'string' || typeof u.clientUuid !== 'string') return undefined;
  const attachments = Array.isArray(u.attachments) ? u.attachments.filter(a => a && typeof a.sha256 === 'string') : [];
  return { text: u.text, attachments, clientUuid: u.clientUuid };
}

/** claude-subscriptions: the structured part of a subscription note, when the hub sent it in the agreed shape. */
function subscriptionOf(ev: Extract<HubEvent, { kind: 'note' }>): SubscriptionNote | undefined {
  const n: Partial<SubscriptionNote> | undefined = ev.subscription;
  if (!n || typeof n.subscriptionId !== 'string' || (n.kind !== 'limit' && n.kind !== 'auth' && n.kind !== 'switch')) return undefined;
  const alternatives = Array.isArray(n.alternatives) ? n.alternatives.filter((x): x is string => typeof x === 'string') : undefined;
  return { kind: n.kind, subscriptionId: n.subscriptionId, ...(typeof n.resetsAt === 'string' ? { resetsAt: n.resetsAt } : {}), ...(alternatives ? { alternatives } : {}) };
}

/** Images among the blocks of a tool result (Read of a picture, screenshots of MCP servers). */
function resultImages(content: unknown): ImageRef[] {
  return Array.isArray(content) ? content.flatMap(b => (i => (i ? [i] : []))(imageOfBlock(b))) : [];
}

const TEAMMATE = /^<teammate-message\s+teammate_id="([^"]+)"[^>]*>([\s\S]*?)(?:<\/teammate-message>\s*)?$/;

/** «Уведомление: <summary>» of a `<task-notification>` (status when there is no summary). */
export function notificationText(content: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(content)?.[1]?.trim();
  const status = /<status>([^<]+)<\/status>/.exec(content)?.[1]?.trim();
  return tr('chat.tr.notification', { text: summary || (status ? tr('chat.tr.taskStatus', { status }) : tr('chat.tr.task')) });
}

function userText(content: string): ChatItem | null {
  if (INTERRUPTED.test(content)) return null;
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(content);
  if (cmd) return { kind: 'note', id: '', text: tr('chat.tr.command', { name: cmd[1]!.trim() }) };
  const t = content.trimStart();
  // change `session-peers` D8: a message of another hub session, wrapped by the hub
  const hub = parsePeerMessage(t);
  if (hub) {
    const e = hub.envelope;
    return {
      kind: 'peer',
      id: '',
      from: e.title || tr('chat.tr.session'),
      text: hub.text,
      session: { id: e.from, title: e.title || tr('chat.tr.session'), machine: e.machine, ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}), ...(e.kind ? { kind: e.kind } : {}) },
    };
  }
  // change `subagents` S9: a teammate's message to the lead is not the user's message
  const mate = TEAMMATE.exec(t);
  if (mate) return { kind: 'peer', id: '', from: mate[1]!, text: mate[2]!.trim() };
  if (t.startsWith('<task-notification')) return { kind: 'note', id: '', text: notificationText(t) };
  if (/^<(local-command-|system-reminder)/.test(t)) return null;
  return { kind: 'user', id: '', text: content, images: [] };
}

/**
 * A `queued_command` attachment (change `subagents` S6): a message delivered in the middle of a turn. From a peer —
 * «Сообщение от <name>»; a task notification — a note; the user's own queued text — a user message, unless the same
 * text comes as a user line within the next 50 events (it was delivered in the next turn and is shown there).
 */
function queuedItem(line: TranscriptLine, later: HubEvent[]): ChatItem | null {
  const a = (line as { attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string; name?: string; body?: string; summary?: string } } }).attachment;
  if (!a || a.type !== 'queued_command') return null;
  const prompt = typeof a.prompt === 'string' ? a.prompt : Array.isArray(a.prompt) ? a.prompt.map(b => (b && typeof b === 'object' ? str((b as { text?: unknown }).text) : '')).join('\n') : '';
  const o = a.origin;
  if (o?.kind === 'peer') return { kind: 'peer', id: '', from: o.name ?? tr('chat.tr.agent'), text: (o.body ?? prompt).trim() };
  if (o?.kind === 'task-notification' || prompt.trimStart().startsWith('<task-notification'))
    return { kind: 'note', id: '', text: o?.summary ? tr('chat.tr.notification', { text: o.summary }) : notificationText(prompt) };
  const fromUserText = userText(prompt);
  if (fromUserText?.kind !== 'user') return fromUserText;
  const same = later.slice(0, 50).some(e => {
    if (e.kind !== 'line' || e.line.type !== 'user') return false;
    const c = (e.line.message as { content?: unknown } | undefined)?.content;
    const text =
      typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? str((b as { text?: unknown }).text) : '')).join('\n') : '';
    return text.trim() === prompt.trim();
  });
  return same ? null : fromUserText;
}

function systemNote(line: TranscriptLine): string | null {
  switch (line.subtype) {
    case 'compact_boundary':
      return tr('chat.tr.compacted');
    case 'api_error': {
      const formatted = str((line.error as { formatted?: unknown } | undefined)?.formatted);
      const what = line.content ? str(line.content) : formatted;
      return what ? tr('chat.tr.apiErrorWhat', { what }) : tr('chat.tr.apiError');
    }
    case 'informational':
      return str(line.content) || null;
    default:
      return line.level === 'error' && line.content ? str(line.content) : null;
  }
}

function withUuid(it: ChatItem | null, uuid: string | undefined): ChatItem | null {
  return it && it.kind === 'user' && uuid ? { ...it, uuid } : it;
}

/** The index of the event an item came from (item ids are `<event id>` or `<event id>:<suffix>`). */
function eventIndexOf(itemId: string, byEvent: Map<string, number>): number {
  for (let id = itemId; ;) {
    const at = byEvent.get(id);
    if (at !== undefined) return at;
    const cut = id.lastIndexOf(':');
    if (cut <= 0) return -1;
    id = id.slice(0, cut);
  }
}

/** Fields of an optimistic message the chat needs (attachments.ts OptimisticMessage). */
export interface PendingCopy {
  clientUuid: string;
  text: string;
  images: { sha256?: string }[];
  afterEventId?: string | null;
}

/**
 * Which optimistic copies already have their user line (bug from Ivan, M4b: a message with an image stayed
 * «доставляется…» at the bottom and the answers were drawn above it: a line that came before the copy was registered
 * was never matched again). A line is the copy's when its `uuid` is the clientUuid — the agent sends it as
 * SDKUserMessage.uuid and Claude Code writes it as the line's uuid, with images too (SDK 0.3.310; `promptId` is the
 * CLI's own id). Otherwise the first user line after the copy's place with the same text and the same images (by
 * sha256 when known, else by their number). One line answers one copy.
 */
export function matchPending(items: ChatItem[], events: HubEvent[], pending: PendingCopy[]): Set<string> {
  const done = new Set<string>();
  const used = new Set<string>();
  const users = items.filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user');
  for (const p of pending) {
    const u = users.find(i => !used.has(i.id) && i.uuid === p.clientUuid);
    if (u) {
      used.add(u.id);
      done.add(p.clientUuid);
    }
  }
  const byEvent = new Map(events.map((e, i) => [e.id, i]));
  for (const p of pending) {
    if (done.has(p.clientUuid)) continue;
    const after = p.afterEventId ? (byEvent.get(p.afterEventId) ?? -1) : -1;
    const shas = p.images
      .map(i => i.sha256)
      .filter((x): x is string => !!x)
      .sort();
    const u = users.find(i => {
      if (used.has(i.id) || eventIndexOf(i.id, byEvent) <= after) return false;
      if (i.text.trim() !== p.text.trim() || i.images.length !== p.images.length) return false;
      return (
        shas.length !== p.images.length ||
        i.images
          .map(x => x.sha256)
          .sort()
          .join() === shas.join()
      );
    });
    if (u) {
      used.add(u.id);
      done.add(p.clientUuid);
    }
  }
  return done;
}

/** Where a copy stands: the index of the first item after its `afterEventId` (the end when unknown). */
export function pendingSlot(items: ChatItem[], events: HubEvent[], afterEventId: string | null | undefined): number {
  if (!afterEventId) return items.length;
  const byEvent = new Map(events.map((e, i) => [e.id, i]));
  const after = byEvent.get(afterEventId);
  if (after === undefined) return items.length;
  const at = items.findIndex(i => eventIndexOf(i.id, byEvent) > after);
  return at < 0 ? items.length : at;
}

/**
 * A hub note about a local image shown in the chat (`session_notes kind = 'image'`, D19): `image: {path, blob}` of
 * the event; its text «Изображение: <path>» is only for clients that do not render the image.
 */
export function imageNote(ev: HubEvent): { path: string; image: ImageRef } | null {
  if (ev.kind !== 'note' || !ev.image) return null;
  const b = ev.image.blob;
  return { path: ev.image.path, image: { sha256: b.$blob, mime: b.mime, size: b.size, ...(b.width && b.height ? { width: b.width, height: b.height } : {}) } };
}

/** Local paths already shown in the session, from its image notes. */
export function knownLocalImages(events: HubEvent[]): Record<string, ImageRef> {
  const out: Record<string, ImageRef> = {};
  for (const ev of events) {
    const n = imageNote(ev);
    if (n) out[n.path] = n.image;
  }
  return out;
}

/** Builds chat items from events in their order. Unknown line types are skipped. */
export function buildChat(events: HubEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  const push = (it: ChatItem | null, id: string) => {
    if (it) items.push({ ...it, id } as ChatItem);
  };
  // QA obs 3: one «Ход прерван» per turn — the hub writes its note on «Прервать», Claude Code its own line right after
  const interruptedInTurn = (): boolean => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'user') return false;
      if (it.kind === 'note' && isInterruptedNote(it.text, it.i18nKey)) return true;
    }
    return false;
  };
  const pushInterrupted = (id: string) => {
    if (!interruptedInTurn()) push({ kind: 'note', id: '', text: interruptedNote() }, id);
  };
  // QA obs 3: the retries of one API error (Claude Code writes a line per attempt) are one note with their count
  let apiError: { item: Extract<ChatItem, { kind: 'note' }>; text: string; n: number } | null = null;

  for (const [evIndex, ev] of events.entries()) {
    if (ev.kind === 'note') {
      // an image note is the memory of «Показать изображение», shown in the assistant answer, not as a note
      if (!imageNote(ev)) {
        const u = undeliveredOf(ev);
        const sub = subscriptionOf(ev);
        if (isInterruptedNote(ev.text, ev.i18n?.key) && !u && !sub) pushInterrupted(ev.id);
        else push({ kind: 'note', id: '', text: noteText(ev), ...(ev.i18n ? { i18nKey: ev.i18n.key } : {}), ...(u ? { undelivered: u } : {}), ...(sub ? { subscription: sub } : {}) }, ev.id);
      }
      continue;
    }
    if (ev.kind === 'permission') {
      const r = ev.request;
      if (r.resolvedAt && r.decision && askKind(r) !== 'tool') push({ kind: 'note', id: '', text: answeredText(r) }, ev.id);
      else if (r.resolvedAt && r.decision) {
        const verdict = r.decision === 'deny' ? tr('chat.tr.denied') : r.decision === 'allow_session' ? tr('chat.tr.allowedSession') : tr('chat.tr.allowed');
        push({ kind: 'note', id: '', text: `${r.toolName}: ${verdict}${r.message ? ` — ${r.message}` : ''}` }, ev.id);
      } else push({ kind: 'permission', id: '', request: r }, ev.id);
      continue;
    }
    const line = ev.line;
    const msg = (line.message ?? {}) as { content?: unknown; id?: string };
    if (line.type === 'user') {
      if (line.isMeta || line.isCompactSummary) continue;
      const c = msg.content;
      const uuid = typeof line.uuid === 'string' ? line.uuid : undefined;
      if (typeof c === 'string') {
        if (INTERRUPTED.test(c)) pushInterrupted(ev.id);
        else push(withUuid(userText(c), uuid), ev.id);
        continue;
      }
      if (!Array.isArray(c)) continue;
      // one user message: its texts and its images (pasted in the terminal, attached in the hub) together
      const texts: string[] = [];
      const images: ImageRef[] = [];
      c.forEach((b: Block, n: number) => {
        const id = `${ev.id}:${n}`;
        if (b.type === 'tool_result') {
          const t = tools.get(str(b.tool_use_id));
          if (t) {
            const r = resultText(b.content);
            const side = sideOf(r.text, ev.sideFiles);
            t.result = { text: r.text, isError: b.is_error === true, ...(r.blob ? { blob: r.blob } : {}), ...(side ? { side } : {}) };
            t.images = resultImages(b.content);
            const d = toolDiff(t.name, t.input, line.toolUseResult);
            if (d) t.diff = d;
          }
        } else if (b.type === 'text') {
          const text = str(b.text);
          if (INTERRUPTED.test(text)) pushInterrupted(id);
          else {
            const it = userText(text);
            if (it?.kind === 'user') texts.push(it.text);
            else push(it, id);
          }
        } else {
          const img = imageOfBlock(b);
          if (img) images.push(img);
        }
      });
      if (texts.length || images.length) push({ kind: 'user', id: '', text: texts.join('\n\n'), images, ...(uuid ? { uuid } : {}) }, `${ev.id}:u`);
      continue;
    }
    if (line.type === 'assistant') {
      const c = Array.isArray(msg.content) ? (msg.content as Block[]) : [];
      c.forEach((b, n) => {
        const id = `${ev.id}:${n}`;
        if (b.type === 'text' && str(b.text).trim()) push({ kind: 'assistant', id: '', text: str(b.text), messageId: msg.id }, id);
        else if (b.type === 'tool_use') {
          const name = str(b.name);
          const t: Extract<ChatItem, { kind: 'tool' }> = {
            kind: 'tool',
            id,
            toolUseId: str(b.id),
            name,
            target: toolTarget(name, b.input),
            input: b.input,
            result: null,
            diff: toolDiff(name, b.input, null),
            images: [],
          };
          tools.set(t.toolUseId, t);
          items.push(t);
        }
      });
      continue;
    }
    if (line.type === 'system') {
      const t = systemNote(line);
      if (!t) continue;
      if (line.subtype === 'api_error' && apiError && items.at(-1) === apiError.item && apiError.text === t) {
        apiError.n++;
        apiError.item.text = tr('chat.tr.attempts', { text: t, n: apiError.n });
        continue;
      }
      push({ kind: 'note', id: '', text: t }, ev.id);
      apiError = line.subtype === 'api_error' ? { item: items.at(-1) as Extract<ChatItem, { kind: 'note' }>, text: t, n: 1 } : null;
    } else if (line.type === 'attachment') push(queuedItem(line, events.slice(evIndex + 1)), ev.id);
  }
  return items;
}

/** Assistant message ids already present as lines — their streamed partial text must not be shown twice. */
export function finishedMessageIds(items: ChatItem[]): Set<string> {
  return new Set(items.flatMap(i => (i.kind === 'assistant' && i.messageId ? [i.messageId] : [])));
}
