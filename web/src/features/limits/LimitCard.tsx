/**
 * The limits card of a subscription (Requirement: Карточка лимитов и расшифровки; Ручное обновление; Время сброса;
 * design.md L7; docs/prototype.html limCard). Desktop — a non-modal popover at the row (to the right of the panel) or
 * under the head chip; phone — a bottom sheet over a scrim. Closes on Esc, a press outside and «Закрыть»; Esc and
 * «Закрыть» give the focus back to the row or the chip that opened it. Opening never runs a probe turn (it costs
 * quota): only «Обновить» does, not more often than `refreshableAt` allows, with a countdown.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../store';
import { t as tNow, useT } from '../../i18n';
import { clock } from '../subscriptions/model';
import { closeLimitCard, refreshLimits } from './actions';
import type { LimitOverageView, SubscriptionLimitsView } from '../../api/types';
import { exhaustionRules, heldText, isKnownWindow, overageDesc, quietText, reasonAdvice, reasonText, refreshHint, unknownWindowDesc, windowText } from './limitTexts';
import { beforeQuiet, fmtPct, heldOverQuiet, isReset, lastSource, limitedUntil, levelLong, outdatedMachines, refreshLeft, relIn, sourceLabel, windowLevel } from './limitsModel';
import { LevelBadge, LimitBar, useHubNow } from './parts';

const CARD_W = 380;

function anchorOf(id: string, from: 'row' | 'chip'): HTMLElement | null {
  const sel = from === 'chip' ? `.lchip[data-sub="${id}"]` : `[data-sub="${id}"]:not(.lchip)`;
  const all = [...document.querySelectorAll<HTMLElement>(sel)];
  return all.find(el => el.getClientRects().length > 0) ?? all[0] ?? null;
}

export function overageText(o: LimitOverageView): string {
  if (o.enabled === false) return tNow('limits.overage.off');
  if (o.status === 'rejected') return o.enabled ? tNow('limits.overage.unavailableNoCredits') : tNow('limits.overage.unavailable');
  if (o.inUse) return tNow('limits.overage.inUse');
  if (o.enabled) return tNow('limits.overage.enabled');
  return tNow('limits.overage.unknown');
}

export function LimitCard() {
  const target = useStore(s => s.limitCard);
  if (!target) return null;
  return <Card key={`${target.subscriptionId}:${target.from}`} id={target.subscriptionId} from={target.from} />;
}

function Card({ id, from }: { id: string; from: 'row' | 'chip' }) {
  const t = useT();
  const now = useHubNow();
  const sub = useStore(s => s.subs?.subscriptions.find(x => x.id === id && !x.retired));
  const subsLoaded = useStore(s => !!s.subs);
  const lim = useStore(s => s.limits?.limits.find(l => l.subscriptionId === id));
  const runners = useStore(s => s.runners);
  const phone = useStore(s => s.device === 'phone');
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [, tick] = useReducer((x: number) => x + 1, 0);

  const close = (refocus: boolean) => {
    const back = refocus ? anchorOf(id, from) : null;
    closeLimitCard();
    back?.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // the place at the opener; the focus moves into the card
  useLayoutEffect(() => {
    if (!phone) {
      const a = anchorOf(id, from);
      if (a) {
        const r = a.getBoundingClientRect();
        if (from === 'chip') setPos({ left: Math.max(12, Math.min(r.right - CARD_W, window.innerWidth - CARD_W - 12)), top: r.bottom + 6, maxHeight: window.innerHeight - r.bottom - 18 });
        else {
          const side = document.querySelector('.side')?.getBoundingClientRect();
          setPos({ left: (side?.right ?? r.right) + 8, bottom: Math.max(12, window.innerHeight - r.bottom) });
        }
      }
    } else setPos({});
    box.current?.focus({ preventScroll: true });
  }, [id, from, phone]);

  // the subscription went away (deleted, retired) while the card was open: the card closes (review A8)
  useEffect(() => {
    if (subsLoaded && !sub) closeLimitCard();
  }, [subsLoaded, sub]);

  // Esc and a press outside close the card — only while it is the top layer (review A8): a modal dialog over it (e.g.
  // «Идёт ход: прервать и переключить?») makes `.app` with the card inert and handles Esc itself, as a menu inside a
  // dialog does (useMenu). Otherwise Esc is taken before the hotkeys and nothing behind the card sees it.
  useEffect(() => {
    const covered = () => !!box.current?.closest('[inert]');
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || covered()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current(true);
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (covered()) return;
      const t = e.target as Element | null;
      if (box.current?.contains(t as Node) || t?.closest?.('[data-lim-trigger]')) return;
      closeRef.current(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  const left = refreshLeft(lim, Date.now() + useStore.getState().limitsSkew);
  // the countdown of «Обновить через N с» runs each second while it lasts
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sub) return null;
  const until = limitedUntil(sub, now);
  const reason = sub.tokenRejected ? 'token_rejected' : lim?.state === 'unavailable' ? (lim.reason ?? 'not_polled') : !lim ? 'not_polled' : null;
  const stale = lim?.state === 'stale';
  // a window keeps its level over the latest quiet check: no «ниже порога» plate (fix 2026-10-29)
  const held = !!lim && lim.state === 'ok' && lim.windows.some(w => heldOverQuiet(w, lim, now));
  const blocked = reason === 'token_rejected' || reason === 'no_runner' || reason === 'agent_outdated';
  const why =
    reason === 'token_rejected'
      ? t('limits.card.unavailableToken')
      : reason === 'no_runner'
        ? t('limits.card.unavailableNoRunner')
        : reason === 'agent_outdated'
          ? t('limits.card.unavailableOutdated')
          : refreshHint();

  const onRefresh = async () => {
    setBusy(true);
    setNote(null);
    const r = await refreshLimits(id);
    setBusy(false);
    if (r.ok) setNote({ ok: true, text: t('limits.card.probeRequested') });
    else if (r.message) setNote({ ok: false, text: r.message });
  };

  const rejectedWin = lim?.windows.find(w => w.status === 'rejected');
  const exhaustedBy = windowText(sub.limitKind ?? rejectedWin?.type ?? 'seven_day').name;

  return (
    <>
      {phone && <div className="lc-scrim" aria-hidden="true" onClick={() => close(false)} />}
      <div className={`lcard${phone ? ' sheet' : ''}`} role="dialog" aria-labelledby="lc-h" tabIndex={-1} ref={box} style={pos}>
        <div className="lc-head">
          <h3 id="lc-h">
            {sub.name}
            <span className="hint">{t('limits.card.subtitle')}</span>
          </h3>
          <button type="button" className="icon-btn" aria-label={t('limits.card.close')} title={t('limits.card.closeEsc')} onClick={() => close(true)}>
            ×
          </button>
        </div>
        <div className="lc-body">
          {until && !reason && (
            <div className="lc-alert">
              <LevelBadge badge="full" />
              <div>
                <b>{t('limits.card.exhaustedUntil', { time: clock(until, new Date(now)) })}</b> · {relIn(until, now)}. {t('limits.card.exhaustedBody', { window: exhaustedBy })}
              </div>
            </div>
          )}
          {reason && (
            <div className="lc-alert nd">
              <LevelBadge badge="nodata" />
              <div>
                <b>{t('limits.card.noData', { reason: reasonText(reason, outdatedMachines(runners)) })}</b> {reasonAdvice(reason)}
                {lim?.lastOkAt && ` ${t('limits.card.lastData', { time: clock(lim.lastOkAt, new Date(now)) })}`}
              </div>
            </div>
          )}
          {stale && lim && (
            <div className="lc-alert nd">
              <LevelBadge badge="neutral" />
              <div>
                <b>{t('limits.card.dataFrom', { time: clock(lim.lastOkAt ?? lim.staleAt ?? new Date(now).toISOString(), new Date(now)) })}</b> {t('limits.card.staleBody')}
              </div>
            </div>
          )}
          {lim?.quietAt &&
            (held ? (
              <div className="lc-alert nd">
                <LevelBadge badge="neutral" />
                <div>
                  <b>{t('limits.card.heldTitle', { time: clock(lim.quietAt, new Date(now)) })}</b> {heldText()}
                </div>
              </div>
            ) : (
              <div className="lc-alert nd">
                <LevelBadge badge="quiet" />
                <div>
                  <b>{t('limits.card.belowThreshold')}</b> · {t('limits.card.checkedAt', { time: clock(lim.quietAt, new Date(now)) })} {quietText()}
                </div>
              </div>
            ))}
          {lim?.windows.map(w => {
            const hold = lim.state === 'ok' && heldOverQuiet(w, lim, now);
            return <WindowBlock key={w.type} w={w} now={now} neutral={stale || !!reason} quietAt={beforeQuiet(w, lim) ? lim.quietAt : null} held={hold} />;
          })}
          {lim?.overage && (
            <div className="lc-over">
              <b>{t('limits.card.overage')}</b> {overageText(lim.overage)} {overageDesc()}
            </div>
          )}
          {lim && !reason && <Meta lim={lim} now={now} />}
          <div className="lc-refresh">
            {busy ? (
              <button type="button" className="btn" disabled>
                {t('limits.card.checking')}
              </button>
            ) : left > 0 ? (
              <button type="button" className="btn" disabled>
                {t('limits.card.refreshIn', { n: left })}
              </button>
            ) : (
              <button type="button" className="btn" disabled={blocked} onClick={() => void onRefresh()}>
                {t('limits.card.refresh')}
              </button>
            )}
            <span className="hint">{why}</span>
          </div>
          {note && (
            <p className={`hint lc-note${note.ok ? '' : ' err'}`} role="status">
              {note.text}
            </p>
          )}
          <p className="lc-rules">{exhaustionRules()}</p>
        </div>
      </div>
    </>
  );
}

/**
 * One window; `quietAt` — a quiet check newer than the window: its percent is the last known value. Without a level,
 * unless `held` (the window is at or above the threshold and its reset has not come: fix 2026-10-29).
 */
function WindowBlock({ w, now, neutral, quietAt, held }: { w: SubscriptionLimitsView['windows'][number]; now: number; neutral: boolean; quietAt: string | null; held: boolean }) {
  const t = useT();
  const text = windowText(w.type);
  const known = isKnownWindow(w.type);
  const reset = isReset(w, now);
  const level = reset || neutral || (quietAt && !held) ? null : windowLevel(w);
  const badge = level ?? 'neutral';
  return (
    <div className={`lw${known ? '' : ' unknown'}`}>
      <div className="lw-top">
        <b>{text.name}</b>
        {level && level !== 'ok' && (
          <>
            <LevelBadge badge={level} />
            <span className="lword">{levelLong(level)}</span>
          </>
        )}
        <span className="sp" />
        {!reset && <span className="pct">{w.utilization != null ? `${fmtPct(w.utilization)}%` : t('limits.card.na')}</span>}
      </div>
      {reset ? (
        <>
          <span className="lbar reset" aria-hidden="true" />
          <div className="lw-reset">{t('limits.card.windowReset', { time: clock(w.resetsAt!, new Date(now)) })}</div>
        </>
      ) : (
        <>
          {w.utilization != null && <LimitBar pct={w.utilization} badge={badge} label={text.name} />}
          <div className="lw-reset">{w.resetsAt ? t('limits.card.resetsAt', { at: clock(w.resetsAt, new Date(now)), rel: relIn(w.resetsAt, now) }) : t('limits.card.resetUnknown')}</div>
          {quietAt && held && <div className="lw-reset lw-old">{t('limits.card.heldValue', { observed: clock(w.observedAt, new Date(now)), quiet: clock(quietAt, new Date(now)) })}</div>}
          {quietAt && !held && (
            <div className="lw-reset lw-old">
              {t('limits.card.lastKnown', {
                pct: w.utilization != null ? ` ${fmtPct(w.utilization)}%` : '',
                observed: clock(w.observedAt, new Date(now)),
                quiet: clock(quietAt, new Date(now)),
              })}
            </div>
          )}
        </>
      )}
      <p className="lw-desc">{text.desc ?? unknownWindowDesc()}</p>
    </div>
  );
}

function Meta({ lim, now }: { lim: SubscriptionLimitsView; now: number }) {
  const t = useT();
  const src = lastSource(lim);
  const n = new Date(now);
  return (
    <div className="lc-meta">
      {lim.lastOkAt ? (
        <span>{src ? t('limits.card.updatedAtSource', { time: clock(lim.lastOkAt, n), source: sourceLabel(src) }) : t('limits.card.updatedAt', { time: clock(lim.lastOkAt, n) })}</span>
      ) : (
        <span>{t('limits.card.noWindowsYet')}</span>
      )}
      {lim.lastProbeAt && <span>{t('limits.card.probeAt', { time: clock(lim.lastProbeAt, n) })}</span>}
    </div>
  );
}
