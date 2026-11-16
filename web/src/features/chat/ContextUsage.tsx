/**
 * The context window of a session (spec `session-context-usage`): the ring with the percentage in the composer row and,
 * on click, the breakdown — a bar of categories, «Не в окне», lists of MCP servers, memory files, skills and agents, and
 * «Сжать контекст» for Claude. On the phone the breakdown is a bottom sheet.
 * Requirements: «Индикатор заполнения в поле ввода», «Разбивка контекстного окна», «Сжатие контекста из хаба».
 * API: GET /api/sessions/:id/context; the ring reads `SessionView.context`.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ContextCategory, SessionContextView } from '@agent-hub/shared';
import type { SessionView } from '../../api/types';
import { api } from '../../api/client';
import { useMenu } from '../ui/a11y';
import { compactContext } from '../workspace/actions';
import { useT } from '../../i18n';

const WARN = 80;
const DANGER = 95;
const R = 7;
const C = 2 * Math.PI * R;

/** 950 → «950», 66 300 → «66k», 1 234 567 → «1.2M». */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function contextTone(percent: number): 'danger' | 'warn' | '' {
  if (percent >= DANGER) return 'danger';
  if (percent >= WARN) return 'warn';
  return '';
}

// the palette of the project groups, defined for both themes
const COLORS: Record<string, string> = {
  system_prompt: 'var(--g-slate)',
  system_tools: 'var(--g-platform)',
  mcp_instructions: 'var(--g-ext)',
  mcp_tools: 'var(--g-customers)',
  custom_agents: 'var(--g-support)',
  memory_files: 'var(--g-org)',
  skills: 'var(--g-tools)',
  messages: 'var(--g-scanner)',
};

function colorOf(c: ContextCategory): string {
  if (c.kind === 'free') return 'var(--line-strong)';
  if (c.kind === 'buffer') return 'var(--faint)';
  return COLORS[c.id] ?? 'var(--g-none)';
}

function Bar({ ctx }: { ctx: SessionContextView }) {
  const cats = ctx.categories ?? [];
  // without categories (Codex) the bar is used and free space only
  const parts = cats.length
    ? [...cats.filter(c => c.kind === 'used'), ...cats.filter(c => c.kind === 'buffer'), ...cats.filter(c => c.kind === 'free')]
    : [
        { id: 'used', name: '', kind: 'used' as const, tokens: ctx.usedTokens },
        { id: 'free_space', name: '', kind: 'free' as const, tokens: Math.max(0, ctx.windowTokens - ctx.usedTokens) },
      ];
  const total = parts.reduce((n, c) => n + c.tokens, 0) || 1;
  return (
    <div className="ctx-bar" aria-hidden="true">
      {parts.map(c => (
        <span key={c.id} className={c.kind} style={{ width: `${(c.tokens / total) * 100}%`, '--cc': cats.length ? colorOf(c) : c.kind === 'free' ? colorOf(c) : 'var(--accent)' } as CSSProperties} />
      ))}
    </div>
  );
}

function Rows({ rows }: { rows: { key: string; name: string; note?: string; tokens: number; color?: string; kind?: string }[] }) {
  return (
    <ul className="ctx-rows">
      {rows.map(r => (
        <li key={r.key} title={r.name}>
          {r.color && <span className={`sw ${r.kind ?? ''}`} style={{ '--cc': r.color } as CSSProperties} />}
          <span className="n">{r.name}</span>
          {r.note && <span className="note">{r.note}</span>}
          <span className="tk">{formatTokens(r.tokens)}</span>
        </li>
      ))}
    </ul>
  );
}

function Fold({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <details className="ctx-fold">
      <summary>
        {title} <span className="note">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function Breakdown({ s, busy }: { s: SessionView; busy: boolean }) {
  const t = useT();
  const [ctx, setCtx] = useState<SessionContextView | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  // a new snapshot (SessionView.context changed) while the panel is open is fetched again
  const at = `${s.context?.usedTokens}/${s.context?.windowTokens}`;
  useEffect(() => {
    let live = true;
    api
      .sessionContext(s.id)
      .then(r => {
        if (!live) return;
        setCtx(r.context);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [s.id, at]);
  const claude = (s.provider ?? 'claude') === 'claude';
  const summary = s.context;
  const cats = ctx?.categories ?? [];
  const inWindow = cats.filter(c => c.kind !== 'deferred');
  const deferred = cats.filter(c => c.kind === 'deferred');
  return (
    <>
      <div className="ctx-head">
        <b>{t('chat.context.panel')}</b>
        {summary && <span>{t('chat.context.summary', { used: formatTokens(summary.usedTokens), window: formatTokens(summary.windowTokens), percent: summary.percent })}</span>}
        {ctx && (
          <span className="note">
            {ctx.model && <span className="mono">{ctx.model} · </span>}
            {t('chat.context.observed', { time: new Date(ctx.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
          </span>
        )}
      </div>
      {ctx === undefined && !failed && <div className="hint">{t('chat.context.loading')}</div>}
      {failed && (
        <div className="hint" role="alert">
          {t('chat.context.failed')}
        </div>
      )}
      {ctx && (
        <>
          <Bar ctx={ctx} />
          {inWindow.length > 0 && <Rows rows={inWindow.map(c => ({ key: c.id, name: c.name, tokens: c.tokens, color: colorOf(c), kind: c.kind }))} />}
          {deferred.length > 0 && (
            <>
              <div className="m-title">{t('chat.context.deferred')}</div>
              <Rows rows={deferred.map(c => ({ key: c.id, name: c.name, tokens: c.tokens }))} />
            </>
          )}
          {!!(ctx.mcpServers?.length || ctx.memoryFiles?.length || ctx.skills?.length || ctx.agents?.length) && <div className="m-title ctx-sep">{t('chat.context.details')}</div>}
          <Fold title={t('chat.context.mcp')} count={ctx.mcpServers?.length ?? 0}>
            <Rows rows={(ctx.mcpServers ?? []).map(m => ({ key: m.name, name: m.name, note: t('chat.context.mcpTools', { loaded: m.loadedTools, tools: m.tools }), tokens: m.tokens }))} />
          </Fold>
          <Fold title={t('chat.context.memory')} count={ctx.memoryFiles?.length ?? 0}>
            <Rows rows={(ctx.memoryFiles ?? []).map(f => ({ key: f.path, name: f.path, note: f.type, tokens: f.tokens }))} />
          </Fold>
          <Fold title={t('chat.context.skills')} count={ctx.skills?.length ?? 0}>
            <Rows rows={(ctx.skills ?? []).map(x => ({ key: `${x.source}:${x.name}`, name: x.name, note: x.source, tokens: x.tokens }))} />
          </Fold>
          <Fold title={t('chat.context.agents')} count={ctx.agents?.length ?? 0}>
            <Rows rows={(ctx.agents ?? []).map(a => ({ key: `${a.source}:${a.agentType}`, name: a.agentType, note: a.source, tokens: a.tokens }))} />
          </Fold>
        </>
      )}
      {claude && (
        <button type="button" className="btn ctx-compact" disabled={busy} title={busy ? t('chat.context.compactBusy') : undefined} onClick={() => void compactContext(s.id)}>
          {t('chat.context.compact')}
        </button>
      )}
    </>
  );
}

/** The ring in the composer row; nothing for a session without a snapshot. `busy` — a turn runs or the session is read-only. */
export function ContextRing({ s, busy }: { s: SessionView; busy: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useMenu(open, box, close);
  const c = s.context;
  if (!c) return null;
  const tone = contextTone(c.percent);
  const fill = Math.min(100, c.percent);
  return (
    <span ref={box} className="ctx-box">
      <button
        ref={btn}
        type="button"
        className={`ctx-ring${tone ? ` ${tone}` : ''}`}
        title={t('chat.context.title', { used: formatTokens(c.usedTokens), window: formatTokens(c.windowTokens) })}
        aria-label={t('chat.context.ring', { percent: c.percent })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <circle className="track" cx="9" cy="9" r={R} />
          <circle className="arc" cx="9" cy="9" r={R} strokeDasharray={`${(fill / 100) * C} ${C}`} transform="rotate(-90 9 9)" />
        </svg>
        <span>{c.percent}%</span>
      </button>
      {open && (
        <>
          <div className="ctx-backdrop" aria-hidden="true" onClick={close} />
          <div className="menu ctx-menu" role="dialog" aria-label={t('chat.context.panel')}>
            <Breakdown s={s} busy={busy} />
          </div>
        </>
      )}
    </span>
  );
}
