/**
 * Chat notes about subscriptions (HubEvent note `subscription`, design P6/P8).
 * Requirements: Исчерпан лимит подписки — «Лимит подписки <имя> исчерпан, сброс в <время>» with «Продолжить под
 * другой подпиской» (a menu of the alternatives, no button without them); Токен отклонён — the hint to issue a new
 * `claude setup-token`, the same button; Автопереключение and the switch from the head — the hub's text.
 * Times are shown in the browser time zone; the hub's `text` is the fallback for an unknown subscription.
 * UI review 6.6: the menu opens above the button when the feed has no room below (C2 — the note is usually the last
 * item, above the composer); «Заменить токен» in the `auth` note opens «Настройки → Подписки» with the token form of
 * that subscription expanded and focused (H2, P12); text and button in one centred column (M1).
 */
import { useRef, useState } from 'react';
import type { SubscriptionNote } from '../../api/types';
import { useStore } from '../../store';
import { t, useT } from '../../i18n';
import { openSettings } from '../settings/Settings';
import { useMenu, useMenuPlacement } from '../ui/a11y';
import { activeSubs, clock, subName } from './model';

export function noteText(n: SubscriptionNote, fallback: string, name: string | null): string {
  if (!name) return fallback;
  if (n.kind === 'limit') return n.resetsAt ? t('subscriptions.note.limitReset', { name, time: clock(n.resetsAt) }) : t('subscriptions.note.limit', { name });
  if (n.kind === 'auth') return t('subscriptions.note.auth', { name });
  return fallback;
}

export function SubscriptionNoteView({ note, text, readOnly, onSwitch }: { note: SubscriptionNote; text: string; readOnly: boolean; onSwitch?: (subscriptionId: string) => void }) {
  const t = useT();
  const subs = useStore(s => s.subs);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenu(open, box, () => setOpen(false));
  const place = useMenuPlacement(open, btn, menu);
  const name = subName(subs, note.subscriptionId);
  // alternatives the hub named that are still active (one may have been retired since the note)
  const noteSub = subs?.subscriptions.find(x => x.id === note.subscriptionId);
  const active = activeSubs(subs, noteSub?.provider ?? 'claude');
  const alts = (note.alternatives ?? []).flatMap(id => active.filter(s => s.id === id));
  const canSwitch = note.kind !== 'switch' && !readOnly && !!onSwitch && alts.length > 0;
  // the subscription is still active and the hub keeps tokens: its token can be replaced right from the note
  const canReplace = note.kind === 'auth' && !readOnly && !!subs?.enabled && active.some(s => s.id === note.subscriptionId);
  return (
    <div className={`sysnote sub-note ${note.kind}`} role={note.kind === 'switch' ? undefined : 'status'}>
      <span className="sub-note-text">{noteText(note, text, name)}</span>
      {(canSwitch || canReplace) && (
        <span className="sub-note-acts">
          {canReplace && (
            <button type="button" className="btn note-retry" onClick={() => openSettings('subscriptions', { tokenFor: note.subscriptionId })}>
              {t('subscriptions.note.replaceToken')}
            </button>
          )}
          {canSwitch && (
            <span className="sub-note-act" ref={box}>
              <button type="button" ref={btn} className="btn note-retry" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
                {t('subscriptions.note.continueUnderOther')}
              </button>
              {open && (
                <div ref={menu} className={`menu${place === 'up' ? ' up' : ''}`} role="menu" aria-label={t('subscriptions.note.continueMenu')}>
                  <div className="m-title">{t('subscriptions.note.continueUnder')}</div>
                  {alts.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        onSwitch!(s.id);
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
