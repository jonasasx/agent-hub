/**
 * The limit chip next to the subscription in the tab head (Requirement: Метка лимита в шапке вкладки; design.md L7):
 * «82% · 5 ч», an exhausted subscription «100% · 7 дн», «ниже порога», or the badge of the reason alone when there is
 * no data. Desktop — after the subscription select; phone — in the session info line. A click opens the card of that
 * subscription (a bottom sheet on the phone). No chip under the machine login.
 */
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { headState } from '../subscriptions/model';
import { runnerIndex } from '../sessions/status';
import { openLimitCard } from './actions';
import { LevelBadge, useHubNow, useLimitRows } from './parts';

export function LimitChip({ s, phone }: { s: SessionView; phone?: boolean }) {
  const now = useHubNow();
  const rows = useLimitRows(now);
  const subs = useStore(st => st.subs);
  const runners = useStore(st => st.runners);
  const st = headState(s, subs, runnerIndex(runners)[s.runnerId]);
  if (!rows || st.kind !== 'select' || !st.value) return null;
  const d = rows.find(r => r.sub.id === st.value);
  if (!d) return null;
  const { sub, row } = d;
  const label = `Лимиты ${sub.name}: ${row.aria}`;
  return (
    <button
      type="button"
      className={`lchip ${row.badge}${phone ? ' chip-phone' : ''}`}
      data-sub={sub.id}
      data-lim-trigger=""
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={() => openLimitCard(sub.id, 'chip')}
    >
      <LevelBadge badge={row.badge} />
      {row.chip}
    </button>
  );
}
