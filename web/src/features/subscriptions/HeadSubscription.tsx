/**
 * «Подписка» in the tab head, next to the mode and the model (Requirement: Подписка в шапке вкладки и переключение;
 * Агент без поддержки подписок; Поведение без подписок). A live process shows its subscription («вход машины» for one
 * run under the machine login), a session without a process — the subscription resume will use, «продолжит под».
 * A pick calls POST /api/sessions/:id/subscription; 409 turn_in_progress opens «Идёт ход: прервать и переключить?».
 * Unavailable for a read-only session and on an offline machine.
 * UI review 6.6: `onPicked` closes the «⋯» menu around the select before the dialog can open (C1); the «⋯» variant
 * names why the select is disabled (H5) and uses short option labels «Имя · до 13:06» (M5).
 */
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { isReadOnly, runnerIndex } from '../sessions/status';
import { switchSubscription } from './actions';
import { LimitChip } from '../limits/LimitChip';
import { CONNECTORS_HINT, MACHINE_LOGIN, activeSubs, headState, shortOptionLabel, subName } from './model';

export function HeadSubscription({ s, inline, onPicked }: { s: SessionView; inline?: boolean; onPicked?: () => void }) {
  const subs = useStore(st => st.subs);
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const runner = idx[s.runnerId];
  const st = headState(s, subs, runner);
  if (st.kind === 'hidden') return null;
  if (st.kind === 'outdated') {
    const tip = `Агент на ${runner?.name ?? s.runnerId} устарел — сессия идёт под входом машины — обновите агента`;
    return inline ? (
      <span className="pill sub-login" title={tip}>
        {MACHINE_LOGIN}
      </span>
    ) : (
      <label>
        Подписка
        <span className="hint" title={tip}>
          {MACHINE_LOGIN} · {tip}
        </span>
      </label>
    );
  }
  const provider = s.provider ?? 'claude';
  const active = activeSubs(subs, provider);
  // the process runs under a subscription retired since: a disabled option with its name, so the select shows it
  const retiredCurrent = st.value !== '' && !active.some(x => x.id === st.value) ? (subName(subs, st.value) ?? s.subscription?.name ?? st.value) : null;
  const disabled = isReadOnly(s, idx) || !runner?.online;
  const now = new Date();
  const why = isReadOnly(s, idx) ? 'Сессия только для чтения' : !runner?.online ? `${runner?.name ?? s.runnerId} не в сети` : null;
  const title = [st.next ? 'Подписка, под которой продолжится сессия' : 'Подписка процесса сессии', why, provider === 'claude' && subs?.connectorsHint ? CONNECTORS_HINT : null]
    .filter(Boolean)
    .join('. ');
  const select = (
    <select
      className="mini"
      aria-label={st.next ? 'Подписка: продолжит под' : 'Подписка'}
      title={title}
      disabled={disabled}
      value={st.value}
      onChange={e => {
        if (!e.target.value || e.target.value === st.value) return;
        onPicked?.();
        void switchSubscription(s.id, e.target.value);
      }}
    >
      {st.value === '' && (
        <option value="" disabled>
          {MACHINE_LOGIN}
        </option>
      )}
      {retiredCurrent !== null && (
        <option value={st.value} disabled>
          {retiredCurrent}
        </option>
      )}
      {active.map(x => (
        <option key={x.id} value={x.id}>
          {/* the inline select is 18ch wide: marks only in the «⋯» variant (short) and in the forms */}
          {inline ? x.name : shortOptionLabel(x, now)}
        </option>
      ))}
    </select>
  );
  if (inline)
    return (
      <span className="ctl-sub">
        {st.next && <span className="sub-next">продолжит под</span>}
        {select}
        <LimitChip s={s} />
      </span>
    );
  return (
    <label>
      {st.next ? 'Подписка — продолжит под' : 'Подписка'}
      {select}
      {why && <span className="hint sub-why">{why}</span>}
      {provider === 'claude' && subs?.connectorsHint && <span className="hint">{CONNECTORS_HINT}</span>}
    </label>
  );
}
