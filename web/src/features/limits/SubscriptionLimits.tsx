/**
 * The block «Лимиты» in the left panel, above the machines footer and outside the scrolling project list (Requirement:
 * Блок «Лимиты» в левой панели; design.md L7; docs/prototype.html limBlock). On the phone the panel is the home screen.
 * From 3 subscriptions on the phone and 4 on the desktop the rows fold into one summary row with the worst
 * subscription; the header button folds and unfolds by hand. Hidden with an empty registry, tokens not kept, or a hub
 * without the limits API.
 */
import { useStore } from '../../store';
import { LimitRow } from './LimitRow';
import { LEVEL_WORD, collapseFrom, worst } from './limitsModel';
import { LevelBadge, LimitBar, useHubNow, useLimitRows } from './parts';

export function SubscriptionLimits() {
  const now = useHubNow();
  const rows = useLimitRows(now);
  const device = useStore(s => s.device);
  const manual = useStore(s => s.limitsCollapsed);
  if (!rows || !rows.length) return null;
  const collapsed = manual ?? rows.length >= collapseFrom(device);
  const toggle = () => useStore.setState({ limitsCollapsed: !collapsed });
  let body;
  if (collapsed) {
    const w = worst(rows)!;
    const { row } = w;
    const word = row.kind === 'full' ? 'исчерпана' : row.badge === 'warn' || row.badge === 'crit' || row.badge === 'full' ? LEVEL_WORD[row.badge] : '';
    const pct = row.kind === 'win' && row.boldPct ? ` ${row.boldPct}` : '';
    body = (
      <button type="button" className="lim-row lim-sum" aria-expanded={false} aria-label={`Лимиты, худшая подписка ${w.sub.name}: ${row.aria}. Развернуть ${rows.length}`} onClick={toggle}>
        <LevelBadge badge={row.badge} />
        <span className="ln">
          худшая: <b>{w.sub.name}</b>
          {pct}
        </span>
        <span className="ll">
          {word}
          <span className="chev" aria-hidden="true">
            ▸ {rows.length}
          </span>
        </span>
        {row.pct != null && <LimitBar pct={row.pct} badge={row.badge} />}
      </button>
    );
  } else body = rows.map(d => <LimitRow key={d.sub.id} data={d} />);
  return (
    <section className="lim" aria-label="Лимиты подписок">
      <h2 className="sec-h">
        Лимиты <span className="n">{rows.length}</span>
        <span className="sp" />
        <button type="button" aria-expanded={!collapsed} onClick={toggle}>
          {collapsed ? 'развернуть' : 'свернуть'}
        </button>
      </h2>
      {body}
    </section>
  );
}
