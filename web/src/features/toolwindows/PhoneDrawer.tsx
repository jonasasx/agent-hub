/**
 * The «☰» of the phone shell (Requirement «Телефон»): a drawer with the windows besides the home screen (Файлы, Машины,
 * Подписки). A choice shows the window over the home screen; the desktop layout stays as it is. Hidden on a wide screen.
 */
import { useState } from 'react';
import { useBadges } from './badges';
import { WIN_IDS, WIN_TITLE } from './dock';
import { IconMenu, railIcon } from './icons';
import { openToolWindow } from './open';
import { menuKeys, usePopupMenu } from './useFlipMenu';
import { usePhone } from './usePhone';

export function PhoneDrawer() {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const badges = useBadges();
  const { box, trigger, menu } = usePopupMenu(open, () => setOpen(false));
  if (!phone) return null;
  return (
    <span ref={box} className="tw-pop">
      <button ref={trigger} type="button" className="icon-btn tw-menu-btn" aria-label="Окна" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {IconMenu}
      </button>
      {open && (
        <div ref={menu} className="tw-menu tw-drawer" role="menu" aria-label="Окна" onKeyDown={menuKeys}>
          {WIN_IDS.filter(id => id !== 'sessions').map(id => (
            <button
              key={id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openToolWindow(id);
              }}
            >
              <span className="tw-mi">{railIcon(id)}</span>
              {WIN_TITLE[id]}
              {badges[id] && <span className="tw-dn">{badges[id]!.text || badges[id]!.tip}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
