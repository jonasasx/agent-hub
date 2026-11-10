// Session peers (change `session-peers`, design D5): the wrapper a peer message wears in the addressee's transcript.
// Built by the hub, parsed by the web (card «От сессии …») and the tests.

/** The in-process MCP server every hub session gets (design D1) and its tools; `mcp__<server>__<tool>` is what the model calls. */
export const PEERS_SERVER_NAME = 'agent-hub';
export const PEERS_TOOLS = {
  list: 'sessions_list',
  get: 'session_get',
  send: 'session_send',
  spawn: 'session_spawn',
  projects: 'projects_list',
  projectCreate: 'project_create',
  projectUpdate: 'project_update',
} as const;
/** Read-only tools: allowed without a permission request (design D7, agent-project-tools D5). */
export const PEERS_READ_TOOL_NAMES: readonly string[] = [PEERS_TOOLS.list, PEERS_TOOLS.get, PEERS_TOOLS.projects].map(t => `mcp__${PEERS_SERVER_NAME}__${t}`);

export interface PeerEnvelope {
  from: string;
  title: string;
  machine: string;
  id: string;
  inReplyTo?: string | undefined;
  /** hub-subagents D6: `spawn` — the task of a child session, `report` — the hub's report of a child's turn. */
  kind?: PeerKind | undefined;
  /** hub-subagents D8: set by the hub when the sender is the session that spawned the addressee (its task-giver). */
  parent?: boolean | undefined;
}

export const PEER_KINDS = ['spawn', 'report'] as const;
export type PeerKind = (typeof PEER_KINDS)[number];

const ATTR = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' } as const;
const escAttr = (v: string): string => v.replace(/[&"<>]/g, c => ATTR[c as keyof typeof ATTR]).replace(/\s+/g, ' ');
const unescAttr = (v: string): string => v.replace(/&quot;|&lt;|&gt;|&amp;/g, m => ({ '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' })[m] as string);

const OPEN = '<peer-message';
const CLOSE = '</peer-message>';

/** `</peer-message` inside the text would end the wrapper early: its `<` becomes `&lt;`. */
const escBody = (t: string): string => t.replace(/<(\/?peer-message)/gi, '&lt;$1');
const unescBody = (t: string): string => t.replace(/&lt;(\/?peer-message)/gi, '<$1');

export function wrapPeerMessage(e: PeerEnvelope, text: string): string {
  const attrs = [`from="${escAttr(e.from)}"`, `title="${escAttr(e.title)}"`, `machine="${escAttr(e.machine)}"`, `id="${escAttr(e.id)}"`];
  if (e.inReplyTo) attrs.push(`in-reply-to="${escAttr(e.inReplyTo)}"`);
  if (e.kind) attrs.push(`kind="${e.kind}"`);
  if (e.parent) attrs.push('parent="true"');
  return `${OPEN} ${attrs.join(' ')}>\n${escBody(text)}\n${CLOSE}`;
}

const WRAPPED = /^<peer-message((?:\s+[a-z-]+="[^"]*")+)>\n([\s\S]*)\n<\/peer-message>$/;

/** The envelope and the text of a user turn that is exactly one peer message; null for anything else. */
export function parsePeerMessage(turn: string): { envelope: PeerEnvelope; text: string } | null {
  const m = WRAPPED.exec(turn.trim());
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1]!.matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1]!] = unescAttr(a[2]!);
  if (!attrs.from || !attrs.id) return null;
  const kind = (PEER_KINDS as readonly string[]).includes(attrs.kind ?? '') ? (attrs.kind as PeerKind) : undefined;
  return {
    envelope: {
      from: attrs.from,
      title: attrs.title ?? '',
      machine: attrs.machine ?? '',
      id: attrs.id,
      ...(attrs['in-reply-to'] ? { inReplyTo: attrs['in-reply-to'] } : {}),
      ...(kind ? { kind } : {}),
      ...(attrs.parent === 'true' ? { parent: true } : {}),
    },
    text: unescBody(m[2]!),
  };
}
