/**
 * One row of the block «Лимиты» (Requirement: Строка подписки; docs/prototype.html limRow): the level badge, the name
 * with an ellipsis, «близко · 5 ч · 82% · 18:40» on the right and the thin bar under the row. A click opens the card.
 */
import { useStore } from '../../store';
import { openLimitCard } from './actions';
import { LevelBadge, LimitBar, type LimitRowData } from './parts';

export function RowText({ row }: { row: LimitRowData['row'] }) {
  if (!row.boldPct) return <>{row.text}</>;
  const i = row.text.indexOf(row.boldPct);
  return (
    <>
      {row.word && (
        <>
          <span className="lword">{row.word}</span> ·{' '}
        </>
      )}
      {row.text.slice(0, i)}
      <b>{row.boldPct}</b>
      {row.text.slice(i + row.boldPct.length)}
    </>
  );
}

export function LimitRow({ data }: { data: LimitRowData }) {
  const { sub, row } = data;
  const open = useStore(s => s.limitCard?.subscriptionId === sub.id && s.limitCard.from === 'row');
  const label = `${sub.name}: ${row.aria}`;
  const muted = row.kind === 'nodata' || row.kind === 'quiet' ? ` ${row.kind}` : '';
  return (
    <button
      type="button"
      className={`lim-row${muted}${open ? ' open' : ''}`}
      data-sub={sub.id}
      data-lim-trigger=""
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${label}. Подробнее`}
      title={`${sub.name} · ${row.aria}`}
      onClick={() => openLimitCard(sub.id, 'row')}
    >
      <LevelBadge badge={row.badge} />
      <span className="ln">{sub.name}</span>
      <span className="ll">
        <RowText row={row} />
      </span>
      {row.pct != null && <LimitBar pct={row.pct} badge={row.badge} />}
    </button>
  );
}
