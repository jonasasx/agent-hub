/**
 * The field «Подписка» of «Новая сессия» and of the handoff form (Requirements: Выбор подписки при запуске и handoff;
 * Последний выбор подписки; Поведение без подписок; Агент без поддержки подписок; Ограничения сессии под подпиской).
 * Hidden with an empty registry; a hint instead of the field for an agent older than 1.4; the hub's default (the last
 * choice) is preselected and followed while the user has not picked one in this form.
 * UI review 6.6: a known limit or a rejected token of the chosen subscription is a warning under the field (C3 — the
 * preselection itself stays the last choice); after 422 subscription_unavailable the text names the subscription that
 * left and the one chosen now instead of sitting next to a silently replaced value (M2).
 */
import { useState } from 'react';
import type { Provider, RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { t, useT } from '../../i18n';
import { connectorsHint, activeSubs, choiceWarning, formField, initialChoice, optionLabel, outdatedText, subName } from './model';

/** «Подписка «X» выведена — выберите другую»: the explicit choice left the active list (QA on prod, 6.6). */
export function goneText(name: string | null): string {
  return t('subscriptions.field.gone', { name: name ?? t('subscriptions.field.chosen') });
}

/**
 * The chosen subscription of a form: `value` — the id to send ('' — nothing to send), `pick` — the user's choice.
 * Follows the hub's default until the user picks. An explicit pick that left the active list (retired in another
 * window, subscriptions.changed) is never replaced silently: the field keeps it as a disabled option, `send` is
 * undefined and `blocked` holds the text — the form does not start until the user picks again (QA on prod, 6.6).
 */
export function useSubscriptionChoice(
  runner: RunnerView | undefined,
  provider: Provider = 'claude',
): {
  value: string;
  pick: (id: string) => void;
  send: string | undefined;
  /** The id the hub refused with 422 subscription_unavailable, until the user picks again. */
  unavailable: string | undefined;
  markUnavailable: () => void;
  /** The text that blocks the start: the explicit choice is no longer active. */
  blocked: string | undefined;
  /** Only a choice the user made in this form (the handoff draft leaves the default to the hub, QA B1). */
  picked: string | undefined;
} {
  const subs = useStore(s => s.subs);
  const [picked, setPicked] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);
  const active = activeSubs(subs, provider);
  const field = formField(subs, runner, provider);
  const gone = field === 'select' && !!picked && !active.some(s => s.id === picked);
  const value = picked && (gone || active.some(s => s.id === picked)) ? picked : initialChoice(subs, provider);
  const send = field === 'select' && value && !gone ? value : undefined;
  const blocked = gone ? goneText(subName(subs, picked)) : undefined;
  return {
    value,
    pick: id => {
      setPicked(id);
      setUnavailable(undefined);
    },
    send,
    unavailable,
    markUnavailable: () => setUnavailable(send),
    blocked,
    picked: send && picked && value === picked ? picked : undefined,
  };
}

/** The text under the field after 422: which subscription left and which one the field shows now. */
function unavailableText(subs: ReturnType<typeof useStore.getState>['subs'], gone: string, now: string): string {
  const goneName = subName(subs, gone);
  const head = goneName ? t('subscriptions.field.unavailableNamed', { name: goneName }) : t('subscriptions.field.unavailable');
  if (now === gone || !now) return t('subscriptions.field.listRefreshing', { head });
  return t('subscriptions.field.nowChosen', { head, name: subName(subs, now) ?? now });
}

export function SubscriptionField({
  id,
  runner,
  provider = 'claude',
  value,
  onChange,
  error,
  unavailableId,
}: {
  id: string;
  runner: RunnerView | undefined;
  provider?: Provider;
  value: string;
  onChange: (id: string) => void;
  error?: string;
  unavailableId?: string;
}) {
  const t = useT();
  const subs = useStore(s => s.subs);
  const field = formField(subs, runner, provider);
  if (field === 'hidden') return null;
  if (field === 'outdated')
    return (
      <div className="field">
        <span className="lbl">{t('subscriptions.field.label')}</span>
        <span className="hint sub-outdated" role="note">
          {outdatedText(runner?.name ?? t('subscriptions.field.machineFallback'))}
        </span>
      </div>
    );
  const now = new Date();
  const active = activeSubs(subs, provider);
  const warning = choiceWarning(
    active.find(s => s.id === value),
    now,
  );
  // the explicit choice left the active list: a disabled option with its name, the text says to pick another
  const gone = value !== '' && !active.some(s => s.id === value);
  const errText = gone ? goneText(subName(subs, value)) : error && unavailableId ? unavailableText(subs, unavailableId, value) : error;
  const describedBy = [errText ? `${id}-err` : null, warning ? `${id}-warn` : null, provider === 'claude' && subs?.connectorsHint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{t('subscriptions.field.label')}</label>
      <select id={id} className="input" value={value} onChange={e => onChange(e.target.value)} aria-invalid={!!errText} aria-describedby={describedBy}>
        {gone && (
          <option value={value} disabled>
            {t('subscriptions.field.retiredOption', { name: subName(subs, value) ?? t('subscriptions.field.label') })}
          </option>
        )}
        {active.map(s => (
          <option key={s.id} value={s.id}>
            {optionLabel(s, now)}
          </option>
        ))}
      </select>
      {errText && (
        <span className="field-error" id={`${id}-err`} role="alert">
          {errText}
        </span>
      )}
      {warning && (
        <span className={`hint sub-warn ${warning.level}`} id={`${id}-warn`}>
          {warning.text}
        </span>
      )}
      {provider === 'claude' && subs?.connectorsHint && (
        <span className="hint" id={`${id}-hint`}>
          {connectorsHint()}
        </span>
      )}
    </div>
  );
}
