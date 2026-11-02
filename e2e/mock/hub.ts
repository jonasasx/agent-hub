/**
 * In-memory hub for web e2e tests without a backend: answers the D10 REST API through Playwright route interception
 * and plays /ws/ui with page.routeWebSocket. Behaviour follows design.md D10 and the shared contract
 * (M2.1: GET/PUT /api/layout — the last snapshot of a device class, last write wins, nothing broadcast; no /api/tabs;
 * permission resolution, message → streamed answer).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route, WebSocketRoute } from '@playwright/test';
import { imageInfo, makePng, sha256 } from './images.js';
import { sessionLines, subagentEvents, subagentRows } from './subagents.js';
import { MockSubscriptions, handleSubscriptions } from './subscriptions.js';
import { MockLimits, handleLimits, mockWindow } from './limits.js';

type Json = Record<string, unknown>;
type Status = 'working' | 'waiting' | 'permission' | 'sleeping' | 'closed';

export interface MockSession {
  id: string;
  title: string;
  runnerId: string;
  cwd: string | null;
  status: Status;
  unread: boolean;
  processAlive: boolean;
  source: string;
  isHubManaged: boolean;
  isCron: boolean;
  readOnlyReason: string | null;
  project: { id: string | null; title: string; colorKey: string; path: string; kind?: string; archived?: boolean };
  secondaryProject?: { id: string; title: string; colorKey: string; path: string } | null;
  projectSource: string;
  projectEvidence: string | null;
  forkOf: { id: string; title: string } | null;
  permissionMode: string;
  model: string | null;
  idleTimeoutMin: number | null;
  effectiveIdleTimeoutMin: number;
  sleepsAt: string | null;
  lastInputAt: string | null;
  lastTurnEndAt: string | null;
  sleptAt: string | null;
  lastEventAt: string | null;
  lastExternalWriteAt: string | null;
  createdAt: string;
  subagents?: { total: number; running: number; working?: number };
  pendingPermission?: { toolName: string } | null;
  externalActive?: boolean;
  /** claude-subscriptions (P8): the subscription of the current/last hub process and the auth of the next one. */
  subscription?: { id: string; name: string } | null;
  subscriptionMode?: 'none' | 'subscription' | 'machine_login' | 'agent_outdated';
  /** mcp-management (M8): servers in failed/needs-auth of the last MCP snapshot. */
  mcpProblems?: number;
}

const NONE = { id: null, title: 'Без проекта', colorKey: 'none', path: '' };
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const RUNNERS = [
  {
    id: 'x1',
    name: 'X1',
    kind: 'machine',
    os: 'Windows 11 Pro',
    online: true,
    lastSeenAt: iso(0),
    agentVersion: '0.2.0',
    claudeVersion: '2.1.296',
    protocolVersion: '1.0',
    incompatible: false,
    vaultRoot: 'C:\\Users\\alice\\vault',
    homeDir: 'C:\\Users\\alice',
  },
  {
    id: 'hp',
    name: 'HP',
    kind: 'machine',
    os: 'Windows 11 Pro',
    online: false,
    lastSeenAt: iso(95),
    agentVersion: '0.2.0',
    claudeVersion: '2.1.296',
    protocolVersion: '1.0',
    incompatible: false,
    vaultRoot: 'C:\\Users\\alice\\vault',
    homeDir: 'C:\\Users\\alice',
  },
  {
    id: 'vm',
    name: 'ВМ .3',
    kind: 'machine',
    os: 'Ubuntu 24.04',
    online: true,
    lastSeenAt: iso(0),
    agentVersion: '0.2.0',
    claudeVersion: '2.1.296',
    protocolVersion: '1.0',
    incompatible: false,
    vaultRoot: '/home/ubuntu/vault',
    homeDir: '/home/ubuntu',
  },
];

function session(n: number, over: Partial<MockSession>): MockSession {
  return {
    id: uuid(n),
    title: `Сессия ${n}`,
    runnerId: 'x1',
    cwd: 'C:\\Users\\alice\\vault',
    status: 'closed',
    unread: false,
    processAlive: false,
    source: 'hub',
    isHubManaged: true,
    isCron: false,
    readOnlyReason: null,
    project: NONE,
    projectSource: 'none',
    projectEvidence: null,
    forkOf: null,
    permissionMode: 'bypassPermissions',
    model: 'opus',
    idleTimeoutMin: null,
    effectiveIdleTimeoutMin: 30,
    sleepsAt: null,
    lastInputAt: null,
    lastTurnEndAt: null,
    sleptAt: null,
    lastEventAt: iso(n * 7),
    lastExternalWriteAt: null,
    createdAt: iso(n * 7 + 5),
    ...over,
  };
}

const FIXTURE = fileURLToPath(new URL('../../web/src/features/chat/fixtures/real-session.jsonl', import.meta.url));

function fixtureEvents(): Json[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, n) => {
      const line = JSON.parse(l) as Json;
      return { kind: 'line', id: `l:1:0:${n}`, ts: String(line.timestamp ?? iso(60)), line };
    });
}

const userLine = (n: string, text: string) => ({ kind: 'line', id: `l:9:0:${n}`, ts: new Date().toISOString(), line: { type: 'user', uuid: n, message: { role: 'user', content: text } } });
const assistantLine = (n: string, msgId: string, text: string) => ({
  kind: 'line',
  id: `l:9:0:${n}`,
  ts: new Date().toISOString(),
  line: { type: 'assistant', uuid: n, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] } },
});

export interface MockHubOptions {
  /** Number of extra closed sessions in «Без проекта» (history). */
  history?: number;
  /** Tabs of the desktop template on the hub (session numbers): one pane, the first tab active. */
  tabs?: number[];
  /** Runners whose agent speaks protocol 1.0: messages with images get 409 agent_outdated (D19). */
  outdated?: string[];
  /** The first N messages with images get 502 attachment_delivery_failed (the machine could not fetch them, D19). */
  failDeliveries?: number;
  /** At most this many events per page of /events (to exercise «Показать раньше»). */
  pageSize?: number;
  /** Change `subagents`: session 1 with a reviewer, a running developer with a nested fix and a teammate. */
  subagents?: boolean;
  /** Every /events answer waits this long (to see the preloaders). */
  eventsDelayMs?: number;
  /** Every /api/blobs answer waits this long (an image arriving late). */
  blobDelayMs?: number;
  /** M4a: sessions spread over vault projects of every area colour (D9), the directory and move/pin endpoints. */
  projects?: boolean;
  /**
   * claude-subscriptions: the registry with «Max личная» and «Pro рабочая», agents at protocol 1.4 (HP stays at 1.3 —
   * «вход машины»). Without it /api/subscriptions answers 404 like a hub before the change.
   */
  subscriptions?: boolean;
  /**
   * subscription-limits (with `subscriptions`): GET /api/subscriptions/limits and refresh, agents X1 and ВМ at 1.6.
   * «Max личная» — 5 ч 82% (близко) and 7 дн 34%, «Pro рабочая» — not polled yet. Without it the limits API is 404.
   */
  limits?: boolean;
  /** Change voice-input: `/api/me.voiceInput` (the hub has an ElevenLabs key). Off by default. */
  voiceInput?: boolean;
}

/** One answer of the mock `POST /api/voice/transcribe` (change voice-input, design D2). */
export interface VoiceAnswer {
  status: number;
  body: Json;
  /** The answer waits this long («Распознаю…» stays on screen). */
  delayMs?: number;
  /** The connection to the hub breaks instead of an answer («Обрыв связи»). */
  abort?: boolean;
}

/**
 * The project directory of the mock (`GET /api/projects`, D10 and the M4a contract): every area colour, builtins, an archived
 * project; by area (area, systems, projects, clones), then «Vault», «Знания», «Без проекта» last.
 */
export const PROJECT_DIR = [
  { id: 'a-scanner', kind: 'area', title: 'Сканер', path: '10-work/01-scanner', areaPath: '10-work/01-scanner', colorKey: 'scanner', archived: false },
  { id: 'p-rkd', kind: 'system', title: '03-scanner-rkd', path: '10-work/01-scanner/systems/03-scanner-rkd', areaPath: '10-work/01-scanner', colorKey: 'scanner', archived: false },
  { id: 'p-site-c', kind: 'project', title: '04-site-c', path: '10-work/01-scanner/projects/04-site-c', areaPath: '10-work/01-scanner', colorKey: 'scanner', archived: false },
  { id: 'p-demo', kind: 'project', title: '06-outage-review', path: '10-work/02-platform/projects/06-outage-review', areaPath: '10-work/02-platform', colorKey: 'platform', archived: false },
  {
    id: 'p-client-b',
    kind: 'project',
    title: '10-client-b-incident',
    path: '10-work/03-customers/projects/10-client-b-incident',
    areaPath: '10-work/03-customers',
    colorKey: 'customers',
    archived: false,
  },
  { id: 'a-support', kind: 'area', title: 'Поддержка', path: '10-work/04-support', areaPath: '10-work/04-support', colorKey: 'support', archived: false },
  { id: 'p-sms', kind: 'system', title: '03-mm-sms-bridge', path: '10-work/04-support/systems/03-mm-sms-bridge', areaPath: '10-work/04-support', colorKey: 'support', archived: false },
  { id: 'p-crm', kind: 'project', title: '04-twenty-crm', path: '10-work/05-infra/projects/99-archive/04-twenty-crm', areaPath: '10-work/05-infra', colorKey: 'infra', archived: true },
  { id: 'p-copilot', kind: 'system', title: '04-copilot', path: '10-work/06-tools/systems/04-copilot', areaPath: '10-work/06-tools', colorKey: 'tools', archived: false },
  { id: 'p-budget', kind: 'system', title: '01-budget', path: '10-work/07-org/systems/01-budget', areaPath: '10-work/07-org', colorKey: 'org', archived: false },
  { id: 'p-pesh', kind: 'project', title: '01-infra-access', path: '11-side/projects/01-infra-access', areaPath: '11-side', colorKey: 'ext', archived: false },
  { id: 'p-ledger', kind: 'system', title: '01-ledger', path: '20-personal/01-finance/systems/01-ledger', areaPath: '20-personal/01-finance', colorKey: 'personal', archived: false },
  { id: 'p-hub', kind: 'system', title: '05-agent-hub', path: '20-personal/05-pos/systems/05-agent-hub', areaPath: '20-personal/05-pos', colorKey: 'personal', archived: false },
  { id: 'b-vault', kind: 'builtin', title: 'Vault', path: '00-meta', areaPath: null, colorKey: 'personal', archived: false },
  { id: 'b-knowledge', kind: 'builtin', title: 'Знания', path: '30-knowledge', areaPath: null, colorKey: 'personal', archived: false },
  { id: 'none', kind: 'none', title: 'Без проекта', path: '', areaPath: null, colorKey: 'none', archived: false },
] as const;

const refOf = (pid: string): MockSession['project'] => {
  const p = PROJECT_DIR.find(x => x.id === pid)!;
  return p.id === 'none' ? NONE : { id: p.id, title: p.title, colorKey: p.colorKey, path: p.path, kind: p.kind, archived: p.archived };
};

/** Session number → [project id, evidence] as the classifier of the hub would put it (D9 p. 6). */
const CLASSIFIED: Record<number, [string, string]> = {
  1: ['p-hub', '3 правки в 05-agent-hub'],
  2: ['p-site-c', 'каталог запуска в 04-site-c'],
  3: ['p-copilot', '2 правки и 5 чтений в 04-copilot'],
  4: ['p-sms', '1 правка в 03-mm-sms-bridge'],
  5: ['p-client-b', '4 правки в 10-client-b-incident'],
  6: ['p-ledger', '6 правок в 01-ledger'],
  7: ['p-rkd', '1 чтение в 03-scanner-rkd'],
  8: ['b-vault', '2 правки в Vault'],
  20: ['p-budget', '1 правка в 01-budget'],
  21: ['p-pesh', 'каталог запуска в 01-infra-access'],
  22: ['p-demo', '2 чтения в 06-outage-review'],
  23: ['p-crm', '3 правки в 04-twenty-crm'],
};

export class MockHub {
  sessions = new Map<string, MockSession>();
  events = new Map<string, Json[]>();
  /** The template of each device class (D10 M2.1): the last PUT wins. */
  layouts: Record<'desktop' | 'phone', { layout: Json | null; savedLayout: Json | null; openedAt: Json | null; updatedAt: string | null; clientTs: number | null; tabKinds?: Json | null }> = {
    desktop: { layout: null, savedLayout: null, openedAt: null, updatedAt: null, clientTs: null },
    phone: { layout: null, savedLayout: null, openedAt: null, updatedAt: null, clientTs: null },
  };
  sockets: WebSocketRoute[] = [];
  received: Json[] = [];
  requests: { method: string; path: string; body: unknown }[] = [];
  private seq = 0;
  /** Objects of `blobs/<sha256>` (D19): images from replicas, uploads and shown local files. */
  blobs = new Map<string, { bytes: Buffer; mime: string }>();
  outdated: string[] = [];
  failDeliveries = 0;
  /** What the classifier says for each session (project id, evidence): «Открепить» returns to it. */
  auto = new Map<string, [string, string]>();
  /** Copies of tool-results on the hub, `<session id>/<name>` → text; a missing one answers 404 (not uploaded yet). */
  toolResults = new Map<string, string>();
  pageSize = 1000;
  eventsDelayMs = 0;
  blobDelayMs = 0;
  /** M4b: forks made through the mock, handoff drafts, the delay of a draft and how many drafts fail. */
  forks: { mode: string; source: string; body: Json }[] = [];
  drafts = new Map<string, { id: string; status: string; text: string | null; error: string | null }>();
  handoffDelayMs = 400;
  /** The user line of a sent message gets a uuid of its own (the clientUuid is lost), as seen on prod with images. */
  foreignLineUuid = false;
  /** Delay of the user line of a sent message (the copy «доставляется…» stays meanwhile). */
  lineDelayMs = 0;
  /** Bodies of POST …/permissions/:id (M4b: answers of AskUserQuestion, the comment of a plan). */
  decisions: Json[] = [];
  /** Change voice-input: the flag of /api/me, the queue of transcribe answers (then `voiceDefault`), what was sent. */
  voiceInput = false;
  voiceAnswers: VoiceAnswer[] = [];
  voiceDefault: VoiceAnswer = { status: 200, body: { text: 'Привет из диктовки' } };
  voiceRequests: { size: number; contentType: string }[] = [];

  /**
   * A request that asks the user (M4b contract): `kind: 'question'` with AskUserQuestion's questions, or `kind: 'plan'`
   * with ExitPlanMode's plan. Stored in the events and sent as permission.request; the session waits for permission.
   */
  /** {total, running} of a session's registry; running = running or idle while the session lives (as the hub). */
  subCounts(sessionId: string) {
    const rows = [...this.subRows.values()].filter(r => r.sessionId === sessionId);
    return { total: rows.length, running: rows.filter(r => r.status === 'running' || r.status === 'idle').length };
  }

  /** A registry row changed: `subagent.upsert` to the parent's subscribers, the session's counters follow. */
  upsertSubagent(row: Json) {
    this.subRows.set(String(row.id), row);
    const s = this.sessions.get(String(row.sessionId));
    this.push({ type: 'subagent.upsert', sessionId: row.sessionId, subagent: row });
    if (s) this.upsert({ ...s, subagents: this.subCounts(s.id) });
  }

  /** New lines of a subagent's transcript: `subagent.events` to the windows where its chat is open. */
  subagentLines(id: string, events: Json[]) {
    this.subEvents.set(id, [...(this.subEvents.get(id) ?? []), ...events]);
    this.push({ type: 'subagent.events', subagentId: id, events });
  }

  ask(n: number, kind: 'question' | 'plan', input: Json): string {
    const s = this.session(n);
    const requestId = `r-${kind}-${++this.seq}`;
    const request = {
      requestId,
      sessionId: s.id,
      kind,
      toolName: kind === 'question' ? 'AskUserQuestion' : 'ExitPlanMode',
      toolUseId: `toolu_${requestId}`,
      input,
      ...(kind === 'question' ? { questions: input.questions } : {}),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      decision: null,
      message: null,
    };
    this.events.get(s.id)!.push({ kind: 'permission', id: `p:${requestId}`, ts: request.createdAt, request });
    this.push({ type: 'permission.request', sessionId: s.id, request });
    this.upsert({ ...s, status: 'permission' });
    return requestId;
  }
  handoffFailures = 0;
  /**
   * change client-versions: what is «deployed» — `/version.json` answers `build`, the client module
   * `src/features/update/currentBuild.ts` is served with `clientBuild` (a reload picks it up, an open page keeps its
   * old one). `deploy()` moves both; `{ client: false }` — the shell stays old (a SW that never takes over, D2).
   */
  build = { version: '0.1.0', commit: '1111111', builtAt: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  clientBuild = { ...this.build };
  /** `/version.json` answers 503 (the hub is down). */
  versionDown = false;
  versionRequests = 0;
  /** Per-runner fields over RUNNERS (agent versions, `outdated`, `update`, name, online, protocolVersion — QA 8.1). */
  runnerPatch: Record<string, Json> = {};

  deploy(commit: string, opts: { client?: boolean } = {}) {
    this.build = { ...this.build, commit, builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    if (opts.client !== false) this.clientBuild = { ...this.build };
  }
  /** claude-subscriptions registry; null — the hub has no subscriptions API (404). */
  subReg: MockSubscriptions | null = null;
  /** subscription-limits snapshots; null — the hub has no limits API (404). */
  limReg: MockLimits | null = null;

  /** A limits event of a session turn: the windows of a subscription change and the windows get the push. */
  limitsEvent(subscriptionId: string, windows: ReturnType<typeof mockWindow>[]) {
    const now = new Date().toISOString();
    this.limReg!.set(subscriptionId, { state: 'ok', reason: null, windows: windows.map(w => ({ ...w, observedAt: now, source: 'session' })), lastOkAt: now });
    this.push({ type: 'subscription_limits.changed' });
  }

  runnerList() {
    const list = !this.subReg ? RUNNERS : RUNNERS.map(r => ({ ...r, protocolVersion: r.id === 'hp' ? '1.3' : this.limReg ? '1.6' : '1.4' }));
    return list.map(r => ({ ...r, ...this.runnerPatch[r.id] }));
  }

  /** A limit note of a session under its subscription (the hub's onResult, design P6). */
  limitNote(n: number) {
    const s = this.session(n);
    const sub = this.subReg!.list.find(x => x.id === s.subscription?.id) ?? this.subReg!.active()[0]!;
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    sub.limitResetsAt = resetsAt;
    const ev = {
      kind: 'note',
      id: `n:${++this.seq}`,
      ts: new Date().toISOString(),
      text: `Лимит подписки ${sub.name} исчерпан`,
      subscription: {
        kind: 'limit',
        subscriptionId: sub.id,
        resetsAt,
        alternatives: this.subReg!.active()
          .filter(x => x.id !== sub.id)
          .map(x => x.id),
      },
    };
    this.events.get(s.id)!.push(ev);
    this.push({ type: 'session.events', sessionId: s.id, events: [ev] });
    this.push({ type: 'subscriptions.changed' });
  }

  /** A rejected-token note of a session under its subscription (the hub marks `tokenRejected`, design P6). */
  authNote(n: number) {
    const s = this.session(n);
    const sub = this.subReg!.list.find(x => x.id === s.subscription?.id) ?? this.subReg!.active()[0]!;
    sub.tokenRejected = true;
    const ev = {
      kind: 'note',
      id: `n:${++this.seq}`,
      ts: new Date().toISOString(),
      text: `Подписка ${sub.name}: токен отклонён`,
      subscription: {
        kind: 'auth',
        subscriptionId: sub.id,
        alternatives: this.subReg!.active()
          .filter(x => x.id !== sub.id)
          .map(x => x.id),
      },
    };
    this.events.get(s.id)!.push(ev);
    this.push({ type: 'session.events', sessionId: s.id, events: [ev] });
    this.push({ type: 'subscriptions.changed' });
  }

  /** The subscription of a launch (create, handoff): an explicit id becomes the last choice, else the default. */
  private launchSub(body: Json): Partial<MockSession> {
    if (!this.subReg || !this.subReg.active().length) return {};
    if (body.runnerId === 'hp') return { subscription: null, subscriptionMode: 'agent_outdated' };
    const id = typeof body.subscriptionId === 'string' ? body.subscriptionId : this.subReg.defaultId();
    if (typeof body.subscriptionId === 'string') {
      this.subReg.lastChoiceId = body.subscriptionId;
      this.push({ type: 'subscriptions.changed' });
    }
    return { subscription: this.subReg.ref(id), subscriptionMode: 'subscription' };
  }

  /** The text of the last user line of a session (for repeatLast). */
  private lastUserText(id: string): string | null {
    const ev = [...(this.events.get(id) ?? [])].reverse().find(e => (e.line as Json | undefined)?.type === 'user');
    const c = ((ev?.line as Json | undefined)?.message as Json | undefined)?.content;
    return typeof c === 'string' ? c : null;
  }

  /** Stores an image and returns its `$blob` reference as the hub puts it into events (D4). */
  addImage(bytes: Buffer): { $blob: string; size: number; mime: string; width?: number; height?: number } {
    const info = imageInfo(bytes);
    const hash = sha256(bytes);
    this.blobs.set(hash, { bytes, mime: info?.mime ?? 'application/octet-stream' });
    return { $blob: hash, size: bytes.length, mime: info?.mime ?? 'application/octet-stream', ...(info ? { width: info.width, height: info.height } : {}) };
  }

  constructor(opts: MockHubOptions = {}) {
    const base: MockSession[] = [
      session(1, { title: 'GUI-прототип Agent Hub', status: 'waiting', processAlive: true, lastEventAt: iso(1), sleepsAt: iso(-27), lastTurnEndAt: iso(3) }),
      session(2, { title: 'Роллаут агента на площадку C, партия 2', runnerId: 'vm', cwd: '/home/ubuntu/vault', status: 'working', processAlive: true, lastEventAt: iso(0) }),
      session(3, {
        title: 'Индексация Notion: вложенные страницы',
        status: 'permission',
        processAlive: true,
        permissionMode: 'default',
        model: 'sonnet',
        lastEventAt: iso(4),
        effectiveIdleTimeoutMin: 120,
      }),
      session(4, { title: '+N подписка для новых сотрудников', status: 'waiting', unread: true, processAlive: true, lastEventAt: iso(9) }),
      session(5, { title: 'Постмортем: тайминги очереди DZI', runnerId: 'hp', status: 'waiting', processAlive: true, lastEventAt: iso(190) }),
      session(6, { title: 'Импорт выписки Т-Банка за октябрь', runnerId: 'vm', cwd: '/home/ubuntu/vault', status: 'sleeping', sleptAt: iso(120), lastEventAt: iso(125) }),
      session(7, { title: 'Сверка трасс кабелей КД', status: 'closed', readOnlyReason: 'cwd_missing', source: 'terminal', isHubManaged: false, lastEventAt: iso(3000) }),
      session(8, { title: 'Правка vault_sync.sh: rebase перед push', status: 'closed', source: 'terminal', isHubManaged: false, lastEventAt: iso(3200), lastExternalWriteAt: iso(2) }),
    ];
    const extra = opts.history ?? 6;
    for (let i = 0; i < extra; i++) base.push(session(20 + i, { title: `Историческая сессия ${i + 1}`, lastEventAt: iso(4000 + i * 100) }));
    for (const s of base) this.sessions.set(s.id, s);
    for (const s of base) this.events.set(s.id, [userLine(`u-${s.id}`, `Задача: ${s.title}`), assistantLine(`a-${s.id}`, `m-${s.id}`, `Ответ по теме «${s.title}».`)]);
    this.events.set(uuid(1), fixtureEvents());
    if (opts.subagents) {
      const s1 = this.sessions.get(uuid(1))!;
      for (const r of subagentRows(s1)) this.subRows.set(String(r.id), r);
      for (const [id, evs] of Object.entries(subagentEvents())) this.subEvents.set(id, evs);
      this.events.get(uuid(1))!.push(...sessionLines());
      this.sessions.set(s1.id, { ...s1, subagents: this.subCounts(s1.id) });
    }
    // a reply found only by its text (Ctrl+K over the history, 3.9); the markup in it must stay text
    this.events.get(uuid(21))!.push(assistantLine('a-21-x', 'm-21-x', 'Причина — ретрай вебхука <img src=x onerror="window.__xss=1"> после таймаута Keycloak.'));
    this.events.get(uuid(3))!.push({
      kind: 'permission',
      id: 'p:r-3',
      ts: iso(4),
      request: {
        requestId: 'r-3',
        sessionId: uuid(3),
        toolName: 'Bash',
        toolUseId: 'toolu_3',
        input: { command: 'npm run crawl -- --source notion --max-depth 6 --dry-run' },
        createdAt: iso(4),
        resolvedAt: null,
        decision: null,
        message: null,
        kind: 'tool',
      },
    });
    this.outdated = opts.outdated ?? [];
    if (opts.subscriptions) {
      const subs = (this.subReg = new MockSubscriptions());
      const a = subs.add('Max личная');
      const pro = subs.add('Pro рабочая');
      if (opts.limits) {
        const lim = (this.limReg = new MockLimits());
        lim.set(a.id, {
          state: 'ok',
          reason: null,
          windows: [mockWindow('five_hour', 82, 130, 'allowed_warning'), mockWindow('seven_day', 34, 5 * 1440)],
          overage: { status: 'rejected', inUse: false, enabled: true },
          lastOkAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        });
        lim.probeResult.set(pro.id, null);
      }
      for (const s of this.sessions.values()) {
        if (s.runnerId === 'hp') Object.assign(s, { subscription: null, subscriptionMode: 'agent_outdated' });
        else Object.assign(s, { subscription: s.processAlive ? { id: a.id, name: a.name } : null, subscriptionMode: 'subscription' });
      }
    }
    this.failDeliveries = opts.failDeliveries ?? 0;
    this.pageSize = opts.pageSize ?? 1000;
    this.eventsDelayMs = opts.eventsDelayMs ?? 0;
    this.blobDelayMs = opts.blobDelayMs ?? 0;
    this.voiceInput = opts.voiceInput ?? false;
    if (opts.projects) {
      for (const [n, [pid, evidence]] of Object.entries(CLASSIFIED)) {
        const s = this.sessions.get(uuid(Number(n)));
        if (!s) continue;
        this.auto.set(s.id, [pid, evidence]);
        this.sessions.set(s.id, { ...s, project: refOf(pid), projectSource: 'auto', projectEvidence: evidence });
      }
      // session 6 was moved by hand earlier; session 1 also touched 03-mm-sms-bridge (the second project)
      const s6 = this.session(6);
      this.sessions.set(s6.id, { ...s6, projectSource: 'manual', projectEvidence: null });
      const s1 = this.session(1);
      const sms = refOf('p-sms');
      this.sessions.set(s1.id, { ...s1, secondaryProject: { id: sms.id!, title: sms.title, colorKey: sms.colorKey, path: sms.path } });
    }
    // session 9: a Playwright screenshot in a tool result, a user message with three images, an answer with
    // Markdown images (a local path and an external link)
    // old enough to sit behind «ещё N» and not to move the rows other tests click
    const s9 = session(9, { title: 'Скриншоты сайта', status: 'waiting', processAlive: true, lastEventAt: iso(9000) });
    this.sessions.set(s9.id, s9);
    const shot = this.addImage(makePng(1280, 720));
    const pics = [makePng(800, 600, [200, 60, 60]), makePng(640, 480, [60, 160, 90]), makePng(320, 200, [120, 90, 200])].map(b => this.addImage(b));
    this.events.set(s9.id, [
      { kind: 'line', id: 'l:9:0:1', ts: iso(5), line: { type: 'user', uuid: 'u9-1', message: { role: 'user', content: 'Сделай скриншот главной' } } },
      {
        kind: 'line',
        id: 'l:9:0:2',
        ts: iso(5),
        line: {
          type: 'assistant',
          uuid: 'a9-2',
          message: { id: 'm9-2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'mcp__playwright__browser_take_screenshot', input: { filename: 'main.png' } }] },
        },
      },
      {
        kind: 'line',
        id: 'l:9:0:3',
        ts: iso(5),
        line: {
          type: 'user',
          uuid: 'u9-3',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu9',
                content: [
                  { type: 'text', text: 'Screenshot taken' },
                  { type: 'image', source: shot },
                ],
              },
            ],
          },
        },
      },
      {
        kind: 'line',
        id: 'l:9:0:4',
        ts: iso(4),
        line: { type: 'user', uuid: 'u9-4', message: { role: 'user', content: [...pics.map(p => ({ type: 'image', source: p })), { type: 'text', text: 'Сравни эти три варианта' }] } },
      },
      {
        kind: 'line',
        id: 'l:9:0:5',
        ts: iso(3),
        line: {
          type: 'assistant',
          uuid: 'a9-5',
          message: {
            id: 'm9-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'График: ![график](/home/ubuntu/vault/.tmp/chart.png)\n\nЛоготип: ![logo](https://example.com/logo.png)\n\nНет файла: ![нет](/home/ubuntu/missing.png)' }],
          },
        },
      },
    ]);
    // session 22: a big Bash output saved by Claude Code to tool-results (its copy on the hub, `sideFiles`) and a message
    // the hub could not deliver (`undelivered`, M3c contract)
    const s22 = uuid(22);
    const lost = this.addImage(makePng(400, 300, [40, 120, 200]));
    this.toolResults.set(`${s22}/toolu_big.txt`, Array.from({ length: 400 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`).join('\n'));
    this.events.get(s22)?.push(
      {
        kind: 'line',
        id: 'l:22:0:3',
        ts: iso(4210),
        line: {
          type: 'assistant',
          uuid: 'a22-3',
          message: { id: 'm22-3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'grep -rn match src' } }] },
        },
      },
      {
        kind: 'line',
        id: 'l:22:0:4',
        ts: iso(4210),
        line: {
          type: 'user',
          uuid: 'u22-4',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_big',
                content:
                  '<persisted-output>\nOutput too large (12.9KB). Full output saved to: /home/ubuntu/.claude/projects/-home-ubuntu-vault/sid22/tool-results/toolu_big.txt\n\nPreview (first 2KB):\nsrc/file0.ts:1: match 0\n</persisted-output>',
              },
            ],
          },
        },
        sideFiles: [{ name: 'toolu_big.txt', url: `/api/sessions/${s22}/tool-results/toolu_big.txt?sid=sid22` }],
      },
      {
        kind: 'note',
        id: 'n:22',
        ts: iso(4205),
        text: 'Сообщение не доставлено — сессия завершилась до доставки, отправьте ещё раз: «проверь вывод» + 1 изображение',
        undelivered: { text: 'проверь вывод', attachments: [{ sha256: lost.$blob, mime: lost.mime, size: lost.size, width: lost.width, height: lost.height }], clientUuid: 'c-lost' },
      },
    );
    const tabs = (opts.tabs ?? []).map(n => uuid(n));
    if (tabs.length) {
      this.layouts.desktop = {
        layout: { layout: { type: 'leaf', pane: 'p1' }, panes: { p1: { id: 'p1', tabs, active: tabs[0] } }, focus: 'p1', seq: 1 },
        savedLayout: null,
        // the first tab was opened longest ago, the last one most recently
        openedAt: Object.fromEntries(tabs.map((t, i) => [t, new Date(Date.now() - (100 - i) * 1000).toISOString()])),
        updatedAt: iso(60),
        clientTs: null,
      };
    }
  }

  static id = uuid;

  session(n: number) {
    return this.sessions.get(uuid(n))!;
  }

  sidebar(cron: boolean) {
    const visible = [...this.sessions.values()].filter(s => cron || !s.isCron).sort((a, b) => Date.parse(b.lastEventAt ?? '') - Date.parse(a.lastEventAt ?? ''));
    const isLive = (s: MockSession) => ['working', 'waiting', 'permission', 'sleeping'].includes(s.status);
    const groups = new Map<string, MockSession[]>();
    for (const s of visible) groups.set(s.project.id ?? 'none', [...(groups.get(s.project.id ?? 'none') ?? []), s]);
    // by last activity, «Без проекта» last (D10)
    const projects = [...groups.values()]
      .map(list => ({ project: list[0]!.project, live: list.filter(isLive).length, total: list.length, lastActivityAt: list[0]!.lastEventAt ?? null, sessions: list.slice(0, 5) }))
      .sort((a, b) => Number(a.project.id === null) - Number(b.project.id === null) || Date.parse(b.lastActivityAt ?? '') - Date.parse(a.lastActivityAt ?? ''));
    return {
      now: visible.filter(s => s.status === 'working' || s.status === 'permission' || (s.status === 'waiting' && s.unread)),
      projects,
      runners: this.runnerList(),
    };
  }

  /**
   * GET /api/search (D10, M3c contract): `{results: [{session, snippet: {text, highlights} | null, match}]}` — title and
   * project, then the text of the replies as plain text with UTF-16 offsets of the match. An empty query gives the
   * recent sessions with `match: 'title'`.
   */
  search(q: string, limit: number, cron: boolean) {
    const needle = q.trim().toLowerCase();
    const all = [...this.sessions.values()].filter(s => cron || !s.isCron).sort((a, b) => Date.parse(b.lastEventAt ?? '') - Date.parse(a.lastEventAt ?? ''));
    if (!needle) return { results: all.slice(0, limit).map(s => ({ session: s, snippet: null, match: 'title' })) };
    const out: Json[] = [];
    for (const s of all) {
      if (s.title.toLowerCase().includes(needle) || s.project.title.toLowerCase().includes(needle)) {
        out.push({ session: s, snippet: null, match: s.title.toLowerCase().includes(needle) ? 'title' : 'project' });
        continue;
      }
      for (const e of this.events.get(s.id) ?? []) {
        const msg = (e.line as { message?: { content?: unknown } } | undefined)?.message?.content;
        const text = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text : '')).join(' ') : '';
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const from = Math.max(0, at - 40);
        const pre = (from ? '…' : '') + text.slice(from, at);
        out.push({ session: s, snippet: { text: pre + text.slice(at, at + needle.length + 80), highlights: [[pre.length, pre.length + needle.length]] }, match: 'text' });
        break;
      }
    }
    return { results: out.slice(0, limit) };
  }

  /** Session ids each socket subscribed to (`subscribe`). */
  private subs = new Map<WebSocketRoute, Set<string>>();
  /** Subagent ids each socket subscribed to (`subscribe.subagentIds`). */
  private subSubs = new Map<WebSocketRoute, Set<string>>();
  /** Registry rows and transcripts of subagents (change `subagents`). */
  subRows = new Map<string, Json>();
  subEvents = new Map<string, Json[]>();

  /**
   * Sends to the user's /ws/ui sockets. Like the hub (D10), chat traffic (session.events, session.partial,
   * permission.*) goes only to sockets subscribed to that session; the rest goes to all.
   */
  push(msg: Json) {
    const scoped = ['session.events', 'session.partial', 'permission.request', 'permission.resolved', 'subagent.upsert'].includes(String(msg.type));
    for (const ws of this.sockets) {
      if (scoped && !this.subs.get(ws)?.has(String(msg.sessionId))) continue;
      // a subagent's feed goes only to the windows where its chat is open
      if (msg.type === 'subagent.events' && !this.subSubs.get(ws)?.has(String(msg.subagentId))) continue;
      ws.send(JSON.stringify(msg));
    }
  }

  /** An assistant answer that appears in a session (e.g. its turn ends while the client looks elsewhere). */
  appendAnswer(n: number, text: string) {
    const s = this.session(n);
    const a = assistantLine(`late${++this.seq}`, `m-late${this.seq}`, text);
    this.events.get(s.id)!.push(a);
    this.push({ type: 'session.events', sessionId: s.id, events: [a] });
    this.upsert({ ...s, status: 'waiting', lastTurnEndAt: new Date().toISOString() });
  }

  upsert(s: MockSession) {
    this.sessions.set(s.id, s);
    this.push({ type: 'session.upsert', session: s });
  }

  /** A reply: working → partial text → assistant line → waiting. Images go first in the user line (D19 p. 5). */
  private reply(s: MockSession, text: string, images: Json[] = [], clientUuid?: string) {
    const msgId = `m-${++this.seq}`;
    const ev = this.events.get(s.id)!;
    // like Claude Code with images (bug from Ivan, M4b): the user line may carry its own uuid, not the clientUuid
    const uid = this.foreignLineUuid || !clientUuid ? `u${this.seq}-${Date.now()}` : clientUuid;
    const u = images.length
      ? {
          kind: 'line',
          id: `l:9:0:${uid}`,
          ts: new Date().toISOString(),
          line: { type: 'user', uuid: uid, message: { role: 'user', content: [...images.map(source => ({ type: 'image', source })), ...(text ? [{ type: 'text', text }] : [])] } },
        }
      : userLine(uid, text);
    ev.push(u);
    this.upsert({ ...s, status: 'working', processAlive: true, lastInputAt: new Date().toISOString(), lastEventAt: new Date().toISOString() });
    this.push({ type: 'session.events', sessionId: s.id, events: [u] });
    const answer = `Принято: «${text}». Готово.`;
    setTimeout(() => this.push({ type: 'session.partial', sessionId: s.id, messageId: msgId, blockIndex: 0, textDelta: answer.slice(0, 10) }), 150);
    setTimeout(() => {
      const a = assistantLine(`a${this.seq}`, msgId, answer);
      ev.push(a);
      this.push({ type: 'session.events', sessionId: s.id, events: [a] });
      const cur = this.sessions.get(s.id)!;
      this.upsert({ ...cur, status: 'waiting', lastTurnEndAt: new Date().toISOString(), sleepsAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    }, 600);
  }

  async install(page: Page) {
    await page.routeWebSocket(/\/ws\/ui$/, ws => {
      this.sockets.push(ws);
      ws.onMessage(m => {
        const msg = JSON.parse(String(m)) as Json;
        this.received.push(msg);
        if (msg.type === 'subscribe') {
          this.subs.set(ws, new Set(msg.sessionIds as string[]));
          this.subSubs.set(ws, new Set((msg.subagentIds as string[] | undefined) ?? []));
        }
      });
      ws.onClose(() => {
        this.sockets = this.sockets.filter(x => x !== ws);
        this.subs.delete(ws);
      });
    });
    await page.route(
      url => /^\/(api|auth)\//.test(url.pathname),
      route => this.handle(route),
    );
    // change client-versions: the hub's build and the build of the shell the browser loads
    await page.route(
      url => url.pathname === '/version.json',
      route => {
        this.versionRequests++;
        if (this.versionDown) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-cache' }, body: JSON.stringify(this.build) });
      },
    );
    await page.route(
      url => url.pathname.endsWith('/src/features/update/currentBuild.ts'),
      route =>
        route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          headers: { 'cache-control': 'no-store' },
          body: `export const CLIENT_BUILD = ${JSON.stringify(this.clientBuild)};
`,
        }),
    );
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let body: Json = {};
    // POST /api/uploads carries the bytes of an image (D10, D19)
    if (path === '/api/uploads' && method === 'POST') {
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      this.requests.push({ method, path, body: { size: bytes.length, contentType: req.headers()['content-type'] } });
      const info = imageInfo(bytes);
      if (!info) return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'not_image' }) });
      if (bytes.length > 4 * 1024 * 1024) return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too_large' }) });
      const known = this.blobs.has(sha256(bytes));
      const ref = this.addImage(bytes);
      // 201 — stored now, 200 — the same image was stored before (D10)
      return route.fulfill({
        status: known ? 200 : 201,
        contentType: 'application/json',
        body: JSON.stringify({ sha256: ref.$blob, mime: info.mime, size: bytes.length, width: info.width, height: info.height }),
      });
    }
    // POST /api/voice/transcribe carries the bytes of a recording (change voice-input, D2): answers from the queue
    if (path === '/api/voice/transcribe' && method === 'POST') {
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      const contentType = req.headers()['content-type'] ?? '';
      this.voiceRequests.push({ size: bytes.length, contentType });
      this.requests.push({ method, path, body: { size: bytes.length, contentType } });
      if (!this.voiceInput) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'voice_disabled', message: 'Диктовка выключена' }) });
      // the order of the hub: 503 and 415 before the body is read, then 400
      if (!/^audio\/(webm|mp4|ogg)(;|$)/.test(contentType)) return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported_audio' }) });
      if (!bytes.length) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'empty_audio' }) });
      const a = this.voiceAnswers.shift() ?? this.voiceDefault;
      if (a.delayMs) await new Promise(r => setTimeout(r, a.delayMs));
      if (a.abort) return route.abort('connectionreset').catch(() => undefined);
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) }).catch(() => undefined);
    }
    if (path.startsWith('/api/blobs/') && method === 'GET') {
      this.requests.push({ method, path, body: {} });
      const b = this.blobs.get(path.slice('/api/blobs/'.length));
      if (this.blobDelayMs) await new Promise(r => setTimeout(r, this.blobDelayMs));
      if (!b) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
      return route.fulfill({ status: 200, contentType: b.mime, body: b.bytes, headers: { 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    try {
      body = (req.postDataJSON() as Json) ?? {};
    } catch {
      body = {};
    }
    this.requests.push({ method, path, body });
    const ok = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const err = (status: number, error: string, message?: string) => ok({ error, message }, status);
    let m: RegExpExecArray | null;

    if (path === '/api/me') return ok({ user: { id: 'u1', email: 'jonasasx@gmail.com', role: 'admin', name: null, provider: 'google' }, vapidPublicKey: null, voiceInput: this.voiceInput });
    if (path === '/api/sidebar') return ok(this.sidebar(url.searchParams.get('cron') === '1'));
    if (path === '/api/search') {
      const limit = Number(url.searchParams.get('limit') ?? 12);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return err(400, 'invalid_request', 'limit 1..50');
      return ok(this.search(url.searchParams.get('q') ?? '', limit, url.searchParams.get('cron') === '1'));
    }
    if (path === '/api/models')
      return ok([
        { value: 'opus', displayName: 'Opus 5.5' },
        { value: 'sonnet', displayName: 'Sonnet 5.5' },
        { value: 'haiku', displayName: 'Haiku 5.5' },
      ]);
    if (path === '/api/projects') return ok(PROJECT_DIR);
    if (path.startsWith('/api/subscriptions')) {
      if (!this.subReg) return err(404, 'not_found');
      if (/^\/api\/subscriptions\/(limits|[^/]+\/limits\/refresh)$/.test(path)) {
        if (!this.limReg) return err(404, 'not_found');
        const reg = this.subReg;
        const r = handleLimits(
          this.limReg,
          path,
          method,
          reg.active().map(x => x.id),
          id => reg.list.find(x => x.id === id) ?? null,
          () => this.push({ type: 'subscription_limits.changed' }),
        );
        if (r) return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body), headers: r.headers });
        return err(404, 'not_found');
      }
      const r = handleSubscriptions(this.subReg, path, method, body, url.searchParams, () => this.push({ type: 'subscriptions.changed' }));
      return r ? ok(r.body, r.status) : err(404, 'not_found');
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/subscription$/.exec(path)) && method === 'POST') {
      // design P6, the hub's order of checks: 423 read-only → 409 runner_offline → 409 agent_outdated → 422 →
      // 409 turn_in_progress (working or permission, unless interrupt). A session without a process — only the last
      // choice, or with repeatLast woken under the new one with the last message; a live one — stop and resume.
      const s = this.sessions.get(m[1]!);
      if (!s || !this.subReg) return err(404, 'not_found');
      this.subReg.switches.push(body);
      if (s.readOnlyReason) return err(423, 'read_only');
      if (!this.runnerList().find(r => r.id === s.runnerId)?.online) return err(409, 'runner_offline');
      if (s.runnerId === 'hp') return err(409, 'agent_outdated');
      const to = this.subReg.active().find(x => x.id === body.subscriptionId);
      if (!to) return err(422, 'subscription_unavailable', 'Подписка недоступна');
      const live = s.processAlive && s.status !== 'sleeping' && s.status !== 'closed';
      // the hub's busyForSwitch: a turn, or a waiting session whose subagents / background commands work
      const busy = s.status === 'working' || s.status === 'permission' || (s.status === 'waiting' && (s.subagents?.working ?? 0) > 0);
      if (live && busy && !body.interrupt) return err(409, 'turn_in_progress', 'Идёт ход');
      this.subReg.lastChoiceId = to.id;
      this.push({ type: 'subscriptions.changed' });
      if (!live && !body.repeatLast) return ok({ session: s }, 202);
      if (live && s.subscription?.id === to.id && !body.repeatLast) return ok({ session: s }, 202);
      const from = s.subscription?.name ?? 'вход машины';
      const now = new Date().toISOString();
      const next: MockSession = {
        ...s,
        status: 'waiting',
        processAlive: true,
        pendingPermission: null,
        sleptAt: null,
        lastTurnEndAt: now,
        subscription: { id: to.id, name: to.name },
        subscriptionMode: 'subscription',
      };
      this.upsert(next);
      const ev = {
        kind: 'note',
        id: `n:${++this.seq}`,
        ts: now,
        text: `Подписка: ${from} → ${to.name}. Первый ход пересчитает контекст без кэша`,
        subscription: { kind: 'switch', subscriptionId: to.id },
      };
      this.events.get(s.id)!.push(ev);
      this.push({ type: 'session.events', sessionId: s.id, events: [ev] });
      const last = body.repeatLast ? this.lastUserText(s.id) : null;
      if (last) setTimeout(() => this.reply(this.sessions.get(s.id)!, last), 50);
      return ok({ session: next }, 202);
    }
    if ((m = /^\/api\/projects\/([^/]+)\/sessions$/.exec(path))) {
      const pid = m[1] === 'none' ? null : m[1];
      const cron = url.searchParams.get('cron') === '1';
      const list = [...this.sessions.values()].filter(s => s.project.id === pid && (cron || !s.isCron)).sort((a, b) => Date.parse(b.lastEventAt ?? '') - Date.parse(a.lastEventAt ?? ''));
      const all = list;
      const off = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      // like the hub (api.ts pageQuery): 1 ≤ limit ≤ 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return err(400, 'invalid_request', 'Too big: expected number to be <=200 at limit');
      return ok({ sessions: list.slice(off, off + limit), total: list.length || all.length });
    }
    if (path === '/api/layout' && method === 'GET') {
      const { clientTs: _ts, ...t } = this.layouts[url.searchParams.get('device') === 'phone' ? 'phone' : 'desktop'];
      return ok(t);
    }
    if (path === '/api/layout' && method === 'PUT') {
      // last write wins unless the stored change is newer by clientTs; no version, nothing broadcast (D10 M2.1)
      const dev = body.device === 'phone' ? 'phone' : 'desktop';
      const ts = typeof body.clientTs === 'number' ? body.clientTs : null;
      const cur = this.layouts[dev];
      if (ts !== null && cur.clientTs !== null && cur.clientTs > ts) return ok({ updatedAt: cur.updatedAt, applied: false });
      this.layouts[dev] = {
        clientTs: ts,
        layout: body.layout as Json,
        savedLayout: (body.savedLayout as Json) ?? null,
        openedAt: (body.openedAt as Json) ?? null,
        tabKinds: (body.tabKinds as Json) ?? null,
        updatedAt: new Date().toISOString(),
      };
      return ok({ updatedAt: new Date().toISOString(), applied: true });
    }
    if (path === '/api/sessions' && method === 'POST') {
      if (String(body.cwd).includes('nope')) return err(422, 'cwd_not_found', `Каталог не найден на ${RUNNERS.find(r => r.id === body.runnerId)?.name}`);
      if (this.subReg && body.subscriptionId && !this.subReg.active().some(x => x.id === body.subscriptionId)) return err(422, 'subscription_unavailable', 'Подписка недоступна');
      const s = session(100 + ++this.seq, {
        title: String(body.prompt).slice(0, 40),
        runnerId: String(body.runnerId),
        cwd: String(body.cwd),
        status: 'working',
        processAlive: true,
        permissionMode: String(body.permissionMode),
        model: String(body.model),
        lastEventAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        ...this.launchSub(body),
      });
      this.sessions.set(s.id, s);
      this.events.set(s.id, []);
      setTimeout(() => this.reply(s, String(body.prompt)), 50);
      return ok(s, 201);
    }
    // M4b (D10, D14): full copy, handoff drafts, handoff start
    if ((m = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path)) && method === 'POST') {
      const src = this.sessions.get(m[1]!);
      if (!src) return err(404, 'not_found');
      const now = new Date().toISOString();
      const inherit =
        src.projectSource === 'manual'
          ? { project: src.project, projectSource: 'manual' as const, projectEvidence: src.projectEvidence }
          : { project: src.project, projectSource: 'inherited' as const, projectEvidence: 'унаследовано от исходной сессии' };
      if (body.mode === 'copy') {
        const online = RUNNERS.find(r => r.id === src.runnerId)?.online;
        if (!online) return err(409, 'runner_offline', 'Машина не в сети');
        if (src.isCron || src.readOnlyReason) return err(409, 'copy_unavailable', 'Копия недоступна');
        const s = session(200 + ++this.seq, {
          title: src.title,
          runnerId: src.runnerId,
          cwd: src.cwd,
          status: 'waiting',
          processAlive: false,
          permissionMode: src.permissionMode,
          model: src.model,
          lastEventAt: now,
          createdAt: now,
          forkOf: { id: src.id, title: src.title },
          ...inherit,
        });
        this.forks.push({ mode: 'copy', source: src.id, body });
        this.sessions.set(s.id, s);
        this.events.set(s.id, [...(this.events.get(src.id) ?? [])]);
        return ok(s, 201);
      }
      if (String(body.cwd).includes('nope')) return err(422, 'cwd_not_found', `Каталог не найден на ${RUNNERS.find(r => r.id === body.runnerId)?.name}`);
      const s = session(200 + ++this.seq, {
        title: `Handoff: ${src.title}`.slice(0, 60),
        runnerId: String(body.runnerId),
        cwd: String(body.cwd),
        status: 'working',
        processAlive: true,
        lastEventAt: now,
        createdAt: now,
        forkOf: { id: src.id, title: src.title },
        ...inherit,
        ...this.launchSub(body),
      });
      this.forks.push({ mode: 'handoff', source: src.id, body });
      this.sessions.set(s.id, s);
      this.events.set(s.id, []);
      setTimeout(() => this.reply(s, String(body.prompt)), 50);
      return ok(s, 201);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/handoff-drafts$/.exec(path)) && method === 'POST') {
      const src = this.sessions.get(m[1]!);
      if (!src) return err(404, 'not_found');
      const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`;
      const fail = this.handoffFailures > 0 && this.handoffFailures-- > 0;
      const draft = { id, status: 'pending' as string, text: null as string | null, error: null as string | null };
      this.drafts.set(id, draft);
      setTimeout(() => {
        Object.assign(
          draft,
          fail
            ? { status: 'error', error: 'Модель не ответила за 120 с' }
            : {
                status: 'ready',
                text: `## Цель
${src.title}

## Что сделано
…

## Следующий шаг
Продолжить.`,
              },
        );
        this.push({ type: 'handoff.draft', draft: { ...draft, sessionId: src.id } });
      }, this.handoffDelayMs);
      return ok({ id, status: 'pending' }, 202);
    }
    if ((m = /^\/api\/handoff-drafts\/([^/]+)$/.exec(path)) && method === 'GET') {
      const d = this.drafts.get(m[1]!);
      return d ? ok(d) : err(404, 'not_found');
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/project$/.exec(path)) && method === 'PUT') {
      // move = pin (D10): manual, a labelled example, the toast project_pinned
      const s = this.sessions.get(m[1]!);
      if (!s) return err(404, 'not_found');
      const pid = String(body.projectId);
      if (!PROJECT_DIR.some(p => p.id === pid)) return err(422, 'unknown_project', 'Проекта нет в справочнике');
      const next: MockSession = { ...s, project: refOf(pid), projectSource: 'manual', projectEvidence: null };
      this.upsert(next);
      this.push({ type: 'toast', kind: 'project_pinned', sessionId: s.id, title: s.title, text: `Проект закреплён: ${next.project.title}` });
      return ok(next);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/pin$/.exec(path))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return err(404, 'not_found');
      let next: MockSession;
      if (method === 'POST') {
        next = { ...s, projectSource: 'manual', projectEvidence: null };
        this.push({ type: 'toast', kind: 'project_pinned', sessionId: s.id, title: s.title, text: `Проект закреплён: ${s.project.title}` });
      } else {
        // unpinned: the classifier decides again
        const a = this.auto.get(s.id);
        next = a ? { ...s, project: refOf(a[0]), projectSource: 'auto', projectEvidence: a[1] } : { ...s, project: NONE, projectSource: 'none', projectEvidence: null };
      }
      this.upsert(next);
      return ok(next);
    }
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(path))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return err(404, 'not_found');
      if (method === 'PATCH') {
        const next = { ...s, ...(body as Partial<MockSession>) };
        if (body.idleTimeoutMin !== undefined) next.effectiveIdleTimeoutMin = (body.idleTimeoutMin as number | null) ?? 30;
        this.upsert(next);
        if (body.permissionMode && s.processAlive) this.push({ type: 'toast', kind: 'mode_changed', sessionId: s.id, text: 'Режим прав изменён — со следующего хода' });
        return ok(next);
      }
      return ok(s);
    }
    // change `subagents` (design S7)
    if ((m = /^\/api\/sessions\/([^/]+)\/subagents$/.exec(path)) && method === 'GET') {
      return ok({ subagents: [...this.subRows.values()].filter(r => r.sessionId === m![1]) });
    }
    if ((m = /^\/api\/subagents\/([^/]+)\/events$/.exec(path)) && method === 'GET') {
      if (!this.subRows.has(m[1]!)) return err(404, 'not_found');
      const all = this.subEvents.get(m[1]!) ?? [];
      const size = Math.min(Number(url.searchParams.get('limit') ?? 200), this.pageSize);
      const b = url.searchParams.get('before');
      const end = b
        ? Math.max(
            0,
            all.findIndex(e => e.id === b),
          )
        : all.length;
      const from = Math.max(0, end - size);
      return ok({ events: all.slice(from, end), before: from > 0 ? String(all[from]!.id) : null });
    }
    if ((m = /^\/api\/subagents\/([^/]+)$/.exec(path)) && method === 'GET') {
      const r = this.subRows.get(m[1]!);
      return r ? ok(r) : err(404, 'not_found');
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/events$/.exec(path))) {
      // pages from the end (D10): `before` is the id of the first event of the previous page
      if (this.eventsDelayMs) await new Promise(r => setTimeout(r, this.eventsDelayMs));
      const all = this.events.get(m[1]!) ?? [];
      const size = Math.min(Number(url.searchParams.get('limit') ?? 200), this.pageSize);
      const b = url.searchParams.get('before');
      const end = b
        ? Math.max(
            0,
            all.findIndex(e => e.id === b),
          )
        : all.length;
      const from = Math.max(0, end - size);
      return ok({ events: all.slice(from, end), before: from > 0 ? String(all[from]!.id) : null });
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path))) {
      const s = this.sessions.get(m[1]!)!;
      if (s.readOnlyReason) return err(423, 'read_only', 'Только чтение');
      if (!RUNNERS.find(r => r.id === s.runnerId)?.online) return err(409, 'runner_offline', 'Машина не в сети');
      if (s.lastExternalWriteAt && !body.force) return err(409, 'concurrent_external', 'Сессия, возможно, открыта в терминале');
      const atts = (body.attachments as { sha256: string }[] | undefined) ?? [];
      if (atts.length && this.outdated.includes(s.runnerId)) return err(409, 'agent_outdated', 'Обновите агент');
      const refs: Json[] = [];
      for (const a of atts) {
        const b = this.blobs.get(a.sha256);
        if (!b) return err(422, 'attachment_not_found');
        refs.push(this.addImage(b.bytes));
      }
      if (atts.length && this.failDeliveries > 0) {
        this.failDeliveries--;
        return err(502, 'attachment_delivery_failed', 'Изображения не дошли до машины — попробуйте ещё раз');
      }
      const go = () => this.reply(s, String(body.text ?? ''), refs, typeof body.clientUuid === 'string' ? body.clientUuid : undefined);
      if (this.lineDelayMs) setTimeout(go, this.lineDelayMs);
      else go();
      return ok({ session: this.sessions.get(s.id) }, 202);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/images$/.exec(path)) && method === 'POST') {
      // «Показать изображение»: the file of the session's machine (D19)
      const p = String(body.path);
      if (p.includes('missing')) return err(404, 'file_not_found', 'Файл не найден на X1');
      const blob = this.addImage(makePng(600, 300, [230, 140, 40]));
      // the hub stores a note kind=image and answers with it; the note also reaches the session events
      const event = { kind: 'note', id: `n:img${++this.seq}`, ts: new Date().toISOString(), text: `Изображение: ${p}`, image: { path: p, blob } };
      this.events.get(m[1]!)?.push(event);
      this.push({ type: 'session.events', sessionId: m[1], events: [event] });
      return ok({ event });
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/tool-results\/([^/]+)$/.exec(path))) {
      const text = this.toolResults.get(`${m[1]}/${m[2]}`);
      if (text === undefined) return err(404, 'not_found', 'Полный вывод ещё не дошёл до хаба — попробуйте позже');
      return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: text, headers: { 'x-content-type-options': 'nosniff' } });
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/wake$/.exec(path))) {
      const s = this.sessions.get(m[1]!)!;
      const note = { kind: 'note', id: `n:${++this.seq}`, ts: new Date().toISOString(), text: 'Поднята через resume' };
      this.events.get(s.id)!.push(note);
      this.push({ type: 'session.events', sessionId: s.id, events: [note] });
      this.upsert({ ...s, status: 'waiting', processAlive: true });
      return ok({ session: this.sessions.get(s.id) }, 202);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(path))) {
      const s = this.sessions.get(m[1]!)!;
      const note = { kind: 'note', id: `n:${++this.seq}`, ts: new Date().toISOString(), text: 'Ход прерван' };
      this.events.get(s.id)!.push(note);
      this.push({ type: 'session.events', sessionId: s.id, events: [note] });
      this.upsert({ ...s, status: 'waiting' });
      return ok({ session: this.sessions.get(s.id) }, 202);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/permissions\/([^/]+)$/.exec(path))) {
      const ev = this.events.get(m[1]!)!.find(e => e.id === `p:${m![2]}`) as { request: Json } | undefined;
      if (!ev) return err(404, 'not_found');
      if (ev.request.resolvedAt) return err(409, 'already_resolved');
      ev.request = {
        ...ev.request,
        resolvedAt: new Date().toISOString(),
        decision: body.decision,
        ...(body.answers ? { answers: body.answers } : {}),
        ...(body.message ? { message: body.message } : {}),
      };
      this.decisions.push({ requestId: m[2]!, ...body });
      this.push({ type: 'permission.resolved', sessionId: m[1], requestId: m[2], decision: body.decision });
      const s = this.sessions.get(m[1]!)!;
      this.upsert({ ...s, status: 'working' });
      return ok({ request: ev.request });
    }
    if (path === '/auth/logout') return route.fulfill({ status: 204 });
    return err(404, 'not_found');
  }
}
