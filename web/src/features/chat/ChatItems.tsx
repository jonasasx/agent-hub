/**
 * Chat items (docs/prototype.html msg()). Requirements (sessions): Обмен сообщениями — user text, assistant Markdown,
 * collapsed tool calls (name and target; expanding shows input and result), Edit/Write diffs, system notes;
 * Карточка разрешения — tool, input and the three buttons.
 * Requirement (chat-images): Изображения от агента в чате — images of a tool result under its collapsed row (seen
 * without expanding it), images of a user message under its text. A text result moved to S3 and a big output saved to
 * tool-results: «Показать полностью». «Сообщение не доставлено»: «Повторить» puts the message back into the composer.
 */
import { Component, useContext, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { t, useT } from '../../i18n';
import { ImageGroup, picOf } from '../images/ImagePreview';
import { blobUrl, formatBytes } from '../images/format';
import { PROVIDER_LABELS, type PermissionDecision, type PermissionView } from '../../api/types';
import { patchDiff, type ChatItem, type DiffLine, type SideFile, type TextBlob, type Undelivered } from './transcript';
import { Markdown } from './Markdown';
import { PlanCard, QuestionCard, askKind } from './AskCards';
import { AgentProvider } from './agentName';
import { ProviderIcon } from './ProviderIcon';
import type { DecideExtra } from '../../api/client';
import { BackgroundStatus, SubagentLink, UserLabel } from '../subagents/SubagentViews';
import { isBackgroundCall } from '../subagents/background';
import { isAgentCall } from '../subagents/model';
import { SubscriptionNoteView } from '../subscriptions/SubscriptionNoteView';
import { openSession } from '../workspace/actions';

const MAX_SHOWN = 20_000;
const cut = (s: string) => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}\n${t('chat.item.cutMore', { count: s.length - MAX_SHOWN })}` : s);

function inputText(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') return `$ ${i.command}`;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((l, n) => (
        <span key={n} className={l.kind}>
          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'ctx' ? ' ' : ''}
          {l.text}
          {'\n'}
        </span>
      ))}
    </>
  );
}

const CHUNK = 64_000;

/**
 * The whole output after «Показать полностью» — never cut (QA M3c: a 340 KB output was cut to 20 000 characters). Up to
 * 200 KB at once; a longer text comes in parts of 64 000 characters: the next part when the end of the shown text
 * scrolls into view, and by the button «Показать дальше» (the phone, no IntersectionObserver), so a tab does not hang
 * on one huge text node.
 */
export function LongText({ text }: { text: string }) {
  const t = useT();
  const big = text.length > 200_000;
  const [shown, setShown] = useState(big ? CHUNK * 2 : text.length);
  const end = useRef<HTMLSpanElement>(null);
  const more = () => setShown(n => Math.min(text.length, n + CHUNK));
  useEffect(() => {
    const el = end.current;
    if (!el || shown >= text.length || typeof IntersectionObserver === 'undefined') return;
    const len = text.length;
    const io = new IntersectionObserver(e => e.some(x => x.isIntersecting) && setShown(n => Math.min(len, n + CHUNK)));
    io.observe(el);
    return () => io.disconnect();
  }, [shown, text.length]);
  const parts: string[] = [];
  for (let at = 0; at < shown; at += CHUNK) parts.push(text.slice(at, Math.min(shown, at + CHUNK)));
  return (
    <>
      <pre className="long-text">
        {parts.map((p, i) => (
          <span key={i}>{p}</span>
        ))}
      </pre>
      {shown < text.length && (
        <span className="t-more" ref={end}>
          <button type="button" className="btn ghost" onClick={more}>
            {t('chat.item.showMore', { size: formatBytes(new Blob([text.slice(shown)]).size) })}
          </button>
        </span>
      )}
    </>
  );
}

/** Loads a whole text for «Показать полностью»; a 404 of a side file carries the hub's explanation. */
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.ok) return r.text();
  let msg = '';
  try {
    msg = String(((await r.json()) as { message?: unknown }).message ?? '');
  } catch {
    // not JSON
  }
  throw new Error(msg || t('chat.item.loadFailed'));
}

/**
 * Result text. A text moved to S3 (D4) shows its preview and loads the rest on request; so does a big output Claude
 * Code saved to tool-results (`<persisted-output>`): «Показать полностью» opens the hub's copy of that file.
 */
function ResultText({ text, blob, side }: { text: string; blob?: TextBlob; side?: SideFile }) {
  const t = useT();
  const [full, setFull] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  if (full !== null) return <LongText text={full} />;
  const url = blob ? blobUrl(blob.sha256) : side?.url;
  const size = blob ? formatBytes(blob.size) : side?.size;
  return (
    <>
      <pre>{cut(text) || t('chat.item.empty')}</pre>
      {url && (
        <span className="t-more">
          <button
            type="button"
            className="btn ghost"
            disabled={state === 'loading'}
            onClick={async () => {
              setState('loading');
              try {
                setFull(await fetchText(url));
              } catch (e) {
                setError((e as Error).message);
                setState('error');
              }
            }}
          >
            {state === 'loading' ? t('chat.item.loading') : size ? t('chat.item.showFullSize', { size }) : t('chat.item.showFull')}
          </button>
          {state === 'error' && (
            <span className="md-img-error" role="status">
              {' '}
              {error}
            </span>
          )}
        </span>
      )}
    </>
  );
}

const ToolCall = memo(function ToolCall({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const t = useT();
  // change `subagents` S9: the chat of the subagent a call started, or of the addressee of SendMessage
  const to = item.name === 'SendMessage' && item.input && typeof item.input === 'object' ? (item.input as { to?: unknown }).to : undefined;
  return (
    <div className="tool-wrap">
      <ToolDetails item={item} />
      {isAgentCall(item.name) && <SubagentLink toolUseId={item.toolUseId} />}
      {typeof to === 'string' && <SubagentLink target={to} label={t('chat.item.chatWith', { name: to })} />}
      {item.toolUseId && isBackgroundCall(item.name, item.input) && <BackgroundStatus toolUseId={item.toolUseId} />}
      {/* screenshots and pictures read by the tool: visible without expanding the call */}
      <ImageGroup pics={item.images.map(picOf)} className="tool-imgs" />
    </div>
  );
});

function ToolDetails({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const t = useT();
  return (
    <details className="tool">
      <summary>
        <span className="chev" aria-hidden="true">
          ›
        </span>
        <span className="tname">{item.name}</span>
        <span className="ttarget">{item.target}</span>
        {item.result?.isError && <span className="terr">{t('chat.item.error')}</span>}
        {!item.result && <span className="g-work" title={t('chat.item.running')} />}
      </summary>
      {item.diff ? (
        <pre>
          <Diff lines={item.diff} />
        </pre>
      ) : (
        <>
          <span className="t-sec">{t('chat.item.input')}</span>
          <pre>{cut(inputText(item.name, item.input))}</pre>
        </>
      )}
      {item.result && !item.diff && (
        <>
          <span className="t-sec">{t('chat.item.result')}</span>
          <ResultText text={item.result.text} blob={item.result.blob} side={item.result.side} />
        </>
      )}
      {item.result?.isError && item.diff && <pre>{cut(item.result.text)}</pre>}
    </details>
  );
}

export function PermissionCard({ request, disabled, onDecide, agent = 'Claude' }: { request: PermissionView; disabled: boolean; onDecide: (d: PermissionDecision) => void; agent?: string }) {
  const t = useT();
  return (
    <div className="perm" role="group" aria-label={t('chat.perm.request', { tool: request.toolName })}>
      <div className="p-head">
        <span className="g-perm" aria-hidden="true">
          !
        </span>
        {t('chat.perm.asks', { agent, tool: request.toolName })}
      </div>
      {request.toolName === 'ApplyPatch' ? (
        <pre>
          <Diff lines={patchDiff(request.input)} />
        </pre>
      ) : (
        <pre>{cut(inputText(request.toolName, request.input))}</pre>
      )}
      <div className="p-actions">
        <button type="button" className="btn primary" disabled={disabled} onClick={() => onDecide('allow')}>
          {t('chat.perm.allow')}
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={() => onDecide('allow_session')}>
          {t('chat.perm.allowSession')}
        </button>
        <button type="button" className="btn danger" disabled={disabled} onClick={() => onDecide('deny')}>
          {t('chat.perm.deny')}
        </button>
      </div>
    </div>
  );
}

export const ChatItemView = memo(function ChatItemView({
  item,
  onDecide,
  onRetry,
  onSwitch,
  readOnly,
}: {
  item: ChatItem;
  readOnly: boolean;
  onDecide: (requestId: string, d: PermissionDecision, extra?: DecideExtra) => void;
  /** «Повторить» on «Сообщение не доставлено»: the text and the images go back into the composer. */
  onRetry?: (u: Undelivered) => void;
  /** claude-subscriptions: «Продолжить под другой подпиской» of a limit / rejected-token note. */
  onSwitch?: (subscriptionId: string) => void;
}) {
  // the label over the user's messages: none in a session, «Лид» in a subagent's feed (no empty element)
  const t = useT();
  const who = useContext(UserLabel);
  const provider = useContext(AgentProvider);
  const agent = PROVIDER_LABELS[provider];
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          {who && <span className="who">{who}</span>}
          {item.text && <div className="bubble user-text">{item.text}</div>}
          <ImageGroup pics={item.images.map(picOf)} className="user-imgs" />
          {item.voice && <span className="voice-mark">{t('chat.talk.voiceMark')}</span>}
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          <span className="who">
            <ProviderIcon provider={provider} size={15} />
          </span>
          <div className="bubble md">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case 'tool':
      return <ToolCall item={item} />;
    case 'note':
      if (item.subscription) return <SubscriptionNoteView note={item.subscription} text={item.text} readOnly={readOnly} onSwitch={onSwitch} />;
      return (
        <div className={`sysnote${item.undelivered ? ' undelivered' : ''}`}>
          {item.text}
          {item.undelivered && onRetry && !readOnly && (
            <button type="button" className="btn note-retry" onClick={() => onRetry(item.undelivered!)}>
              {t('chat.item.retry')}
            </button>
          )}
        </div>
      );
    case 'peer':
      // a teammate's or another agent's message (change `subagents` S6, S9), not the user's
      return (
        <div className="msg peer">
          {item.session ? (
            // change `session-peers` D8: another hub session — a link that opens it
            <span className="who">
              {item.session.kind === 'spawn' ? t('chat.peer.task') : item.session.kind === 'report' ? t('chat.peer.report') : t('chat.peer.from')}{' '}
              <a
                className="peer-from"
                href={`/s/${item.session.id}`}
                onClick={e => {
                  e.preventDefault();
                  openSession(item.session!.id);
                }}
              >
                {item.session.title}
              </a>
              {item.session.machine && <span className="peer-machine"> · {item.session.machine}</span>}
            </span>
          ) : (
            <span className="who">
              {t('chat.peer.message', { name: item.from })} <SubagentLink target={item.from} label={t('chat.item.chatWith', { name: item.from })} />
            </span>
          )}
          <div className="bubble md">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case 'permission': {
      const decideIt = (d: PermissionDecision, extra?: DecideExtra) => onDecide(item.request.requestId, d, extra);
      const k = askKind(item.request);
      if (k === 'question') return <QuestionCard request={item.request} disabled={readOnly} onDecide={decideIt} />;
      if (k === 'plan') return <PlanCard request={item.request} disabled={readOnly} onDecide={decideIt} />;
      return <PermissionCard request={item.request} disabled={readOnly} agent={agent} onDecide={d => onDecide(item.request.requestId, d)} />;
    }
  }
});

/**
 * One chat item that fails to render (an unexpected line of a desktop session with subagents, a broken block) shows a
 * note in its place instead of taking the whole feed down.
 */
export class ItemBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    console.error('chat item', this.props.id, err);
  }
  override render() {
    return this.state.failed ? <div className="sysnote err">{t('chat.item.renderFailed')}</div> : this.props.children;
  }
}
