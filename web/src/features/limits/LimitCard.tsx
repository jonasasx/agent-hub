/**
 * The limits card of a subscription (Requirement: Карточка лимитов и расшифровки; Ручное обновление; Время сброса;
 * design.md L7; docs/prototype.html limCard). Desktop — a non-modal popover at the row (to the right of the panel) or
 * under the head chip; phone — a bottom sheet over a scrim. Closes on Esc, a press outside and «Закрыть»; Esc and
 * «Закрыть» give the focus back to the row or the chip that opened it. Opening never runs a probe turn (it costs
 * quota): only «Обновить» does, not more often than `refreshableAt` allows, with a countdown.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../store';
import { clock } from '../subscriptions/model';
import { closeLimitCard, refreshLimits } from './actions';
import type { LimitOverageView, SubscriptionLimitsView } from '../../api/types';
import { EXHAUSTION_RULES, HELD_TEXT, OVERAGE_DESC, QUIET_TEXT, REFRESH_HINT, UNKNOWN_WINDOW_DESC, WINDOW_TEXTS, reasonAdvice, reasonText, windowText } from './limitTexts';
import { LEVEL_LONG, SOURCE_LABEL, beforeQuiet, fmtPct, heldOverQuiet, isReset, lastSource, limitedUntil, outdatedMachines, refreshLeft, relIn, windowLevel } from './limitsModel';
import { LevelBadge, LimitBar, useHubNow } from './parts';

const CARD_W = 380;

function anchorOf(id: string, from: 'row' | 'chip' | 'summary'): HTMLElement | null {
  const sel = from === 'chip' ? `.lchip[data-sub="${id}"]` : `.lim-row[data-sub="${id}"]`;
  const all = [...document.querySelectorAll<HTMLElement>(sel)];
  return all.find(el => el.getClientRects().length > 0) ?? all[0] ?? document.querySelector<HTMLElement>('.lim-sum');
}

export function overageText(o: LimitOverageView): string {
  if (o.enabled === false) return 'Выключен.';
  if (o.status === 'rejected') return o.enabled ? 'Включён, но недоступен: кредитов нет.' : 'Недоступен.';
  if (o.inUse) return 'Используется сейчас.';
  if (o.enabled) return 'Включён, сейчас не используется.';
  return 'Состояние неизвестно.';
}

export function LimitCard() {
  const target = useStore(s => s.limitCard);
  if (!target) return null;
  return <Card key={`${target.subscriptionId}:${target.from}`} id={target.subscriptionId} from={target.from} />;
}

function Card({ id, from }: { id: string; from: 'row' | 'chip' | 'summary' }) {
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
    reason === 'token_rejected' ? 'Недоступно: токен отклонён.' : reason === 'no_runner' ? 'Недоступно: нет машины в сети.' : reason === 'agent_outdated' ? 'Недоступно: агент устарел.' : REFRESH_HINT;

  const onRefresh = async () => {
    setBusy(true);
    setNote(null);
    const r = await refreshLimits(id);
    setBusy(false);
    if (r.ok) setNote({ ok: true, text: 'Пробный ход запрошен — данные придут в течение минуты.' });
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
            <span className="hint">Лимиты подписки · время сброса по часам браузера</span>
          </h3>
          <button type="button" className="icon-btn" aria-label="Закрыть" title="Закрыть (Esc)" onClick={() => close(true)}>
            ×
          </button>
        </div>
        <div className="lc-body">
          {until && !reason && (
            <div className="lc-alert">
              <LevelBadge badge="full" />
              <div>
                <b>Исчерпана до {clock(until, new Date(now))}</b> · {relIn(until, now)}. Ходы под этой подпиской отклоняются до сброса окна «{exhaustedBy}».
              </div>
            </div>
          )}
          {reason && (
            <div className="lc-alert nd">
              <LevelBadge badge="nodata" />
              <div>
                <b>Нет данных: {reasonText(reason, outdatedMachines(runners))}.</b> {reasonAdvice(reason)}
                {lim?.lastOkAt && ` Последние данные — ${clock(lim.lastOkAt, new Date(now))}.`}
              </div>
            </div>
          )}
          {stale && lim && (
            <div className="lc-alert nd">
              <LevelBadge badge="neutral" />
              <div>
                <b>Данные от {clock(lim.lastOkAt ?? lim.staleAt ?? new Date(now).toISOString(), new Date(now))}.</b> Старше часа, поэтому в предупреждениях не участвуют.
              </div>
            </div>
          )}
          {lim?.quietAt &&
            (held ? (
              <div className="lc-alert nd">
                <LevelBadge badge="neutral" />
                <div>
                  <b>Ход в {clock(lim.quietAt, new Date(now))} прошёл, лимит не исчерпан.</b> {HELD_TEXT}
                </div>
              </div>
            ) : (
              <div className="lc-alert nd">
                <LevelBadge badge="quiet" />
                <div>
                  <b>Ниже порога предупреждения</b> · проверено в {clock(lim.quietAt, new Date(now))}. {QUIET_TEXT}
                </div>
              </div>
            ))}
          {lim?.windows.map(w => {
            const hold = lim.state === 'ok' && heldOverQuiet(w, lim, now);
            return <WindowBlock key={w.type} w={w} now={now} neutral={stale || !!reason} quietAt={beforeQuiet(w, lim) ? lim.quietAt : null} held={hold} />;
          })}
          {lim?.overage && (
            <div className="lc-over">
              <b>Перерасход.</b> {overageText(lim.overage)} {OVERAGE_DESC}
            </div>
          )}
          {lim && !reason && <Meta lim={lim} now={now} />}
          <div className="lc-refresh">
            {busy ? (
              <button type="button" className="btn" disabled>
                Проверяю…
              </button>
            ) : left > 0 ? (
              <button type="button" className="btn" disabled>
                Обновить через {left} с
              </button>
            ) : (
              <button type="button" className="btn" disabled={blocked} onClick={() => void onRefresh()}>
                Обновить
              </button>
            )}
            <span className="hint">{why}</span>
          </div>
          {note && (
            <p className={`hint lc-note${note.ok ? '' : ' err'}`} role="status">
              {note.text}
            </p>
          )}
          <p className="lc-rules">{EXHAUSTION_RULES}</p>
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
  const t = windowText(w.type);
  const known = Object.prototype.hasOwnProperty.call(WINDOW_TEXTS, w.type);
  const reset = isReset(w, now);
  const level = reset || neutral || (quietAt && !held) ? null : windowLevel(w);
  const badge = level ?? 'neutral';
  return (
    <div className={`lw${known ? '' : ' unknown'}`}>
      <div className="lw-top">
        <b>{t.name}</b>
        {level && level !== 'ok' && (
          <>
            <LevelBadge badge={level} />
            <span className="lword">{LEVEL_LONG[level]}</span>
          </>
        )}
        <span className="sp" />
        {!reset && <span className="pct">{w.utilization != null ? `${fmtPct(w.utilization)}%` : 'н/д'}</span>}
      </div>
      {reset ? (
        <>
          <span className="lbar reset" aria-hidden="true" />
          <div className="lw-reset">Окно сброшено в {clock(w.resetsAt!, new Date(now))}, данные обновятся.</div>
        </>
      ) : (
        <>
          {w.utilization != null && <LimitBar pct={w.utilization} badge={badge} label={t.name} />}
          <div className="lw-reset">{w.resetsAt ? `сброс ${clock(w.resetsAt, new Date(now))} · ${relIn(w.resetsAt, now)}` : 'время сброса неизвестно'}</div>
          {quietAt && held && (
            <div className="lw-reset lw-old">
              Значение от {clock(w.observedAt, new Date(now))}; ход в {clock(quietAt, new Date(now))} прошёл без новых данных — лимит не исчерпан.
            </div>
          )}
          {quietAt && !held && (
            <div className="lw-reset lw-old">
              Последнее известное значение{w.utilization != null ? ` ${fmtPct(w.utilization)}%` : ''} от {clock(w.observedAt, new Date(now))}; проверка в {clock(quietAt, new Date(now))} — ниже порога
              предупреждения.
            </div>
          )}
        </>
      )}
      <p className="lw-desc">{t.desc ?? UNKNOWN_WINDOW_DESC}</p>
    </div>
  );
}

function Meta({ lim, now }: { lim: SubscriptionLimitsView; now: number }) {
  const src = lastSource(lim);
  const n = new Date(now);
  return (
    <div className="lc-meta">
      {lim.lastOkAt ? (
        <span>
          Обновлено в {clock(lim.lastOkAt, n)}
          {src ? ` · ${SOURCE_LABEL[src]}` : ''}
        </span>
      ) : (
        <span>Данных об окнах ещё не было</span>
      )}
      {lim.lastProbeAt && <span>Пробный ход в {clock(lim.lastProbeAt, n)}</span>}
    </div>
  );
}
