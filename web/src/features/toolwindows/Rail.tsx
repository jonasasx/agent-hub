/**
 * An icon rail at an edge of the app (docs/prototypes/tool-windows.html rail): the icons are split by lines into groups,
 * a group is a place of the column (several icons are tabs of the place). A click opens the window or hides the open one,
 * a drag moves it. The left rail starts with the brand and keeps the theme and the profile at its foot.
 */
import { useState } from 'react';
import { applyTheme, currentTheme } from '../theme/theme';
import { ProfileMenu } from '../sidebar/ProfileMenu';
import { useBadges, type Badge } from './badges';
import { WIN_TITLE, isOpen, type Side, type WinId } from './dock';
import { beginDrag } from './drag';
import { railIcon } from './icons';
import { useDock } from './useDock';

function RailIcon({ id, side, badge }: { id: WinId; side: Side; badge?: Badge }) {
  const dock = useDock(s => s.dock);
  const toggle = useDock(s => s.toggle);
  const on = isOpen(dock, id);
  const tip = badge?.tip ? `${WIN_TITLE[id]} · ${badge.tip}` : WIN_TITLE[id];
  return (
    <button
      type="button"
      className={`tw-ri${on ? ' on' : ''}`}
      data-id={id}
      data-side={side}
      data-tip={tip}
      aria-label={tip}
      aria-pressed={on}
      onPointerDown={e => beginDrag(id, e)}
      onClick={() => toggle(id)}
    >
      {railIcon(id)}
      {badge && (
        <span className={`tw-bdg${badge.kind === 'dot' ? ' dot' : badge.kind === 'warn' ? ' warn' : ''}`} aria-hidden="true">
          {badge.text}
        </span>
      )}
    </button>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useState(currentTheme);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button type="button" className="tw-ri" data-tip="Сменить тему" onClick={toggle} aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
      ◐
    </button>
  );
}

export function Rail({ side, onLogout }: { side: Side; onLogout?: () => void }) {
  const slots = useDock(s => s.dock[side]);
  const badges = useBadges();
  const groups = slots.flatMap((sl, si) => [
    ...(si ? [<div key={`sep-${si}`} className="tw-rsep" />] : []),
    <div key={`g-${si}`} className="tw-rg" data-si={si}>
      {sl.ids.map(id => (
        <RailIcon key={id} id={id} side={side} badge={badges[id]} />
      ))}
    </div>,
  ]);
  return (
    <nav className={`tw-rail${side === 'right' ? ' right' : ''}`} data-side={side} aria-label={side === 'left' ? 'Окна слева' : 'Окна справа'}>
      {side === 'left' && (
        <div className="tw-brand" aria-hidden="true">
          A
        </div>
      )}
      {groups}
      <div className="tw-grow" />
      {side === 'left' && onLogout && (
        <>
          <ThemeButton />
          <ProfileMenu onLogout={onLogout} variant="rail" />
        </>
      )}
    </nav>
  );
}
