/**
 * The profile menu: versions and the entries that lead to the settings. In the left rail (desktop) and in the top bar of
 * the phone shell (UI review L7: sign-out lives here, not next to the theme switch).
 */
import { useRef, useState } from 'react';
import { useMenu } from '../ui/a11y';
import { useStore, type SettingsTab } from '../../store';
import { openSettings } from '../settings/Settings';
import { HiddenProjects } from '../projects/HiddenProjects';
import { requestUpdate, useUpdate } from '../update/check';
import { formatBuild } from '../update/buildInfo';
import { desktopVersion } from '../update/desktopVersion';
import { useDock } from '../toolwindows/useDock';
import { IconDots } from '../toolwindows/icons';

/**
 * Versions at the bottom of the profile menu (change client-versions, spec «Версии в меню профиля»): the client, the hub
 * («—» until it answers) and, in the desktop app, the app's version from the user-agent.
 */
function Versions() {
  const client = useUpdate(s => s.client);
  const hub = useUpdate(s => s.hub);
  const app = desktopVersion();
  return (
    <dl className="m-ver" aria-label="Версии">
      <dt>Клиент</dt>
      <dd>{formatBuild(client)}</dd>
      <dt>Хаб</dt>
      <dd>{hub ? formatBuild(hub) : '—'}</dd>
      {app && (
        <>
          <dt>Приложение</dt>
          <dd>{app}</dd>
        </>
      )}
    </dl>
  );
}

/** «⋯»: `rail` — the button of the left rail (a tool-window rail icon), otherwise the button of the panel header. */
export function ProfileMenu({ onLogout, variant = 'top' }: { onLogout: () => void; variant?: 'top' | 'rail' }) {
  const [hiddenProjects, setHiddenProjects] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(open, box, () => setOpen(false));
  const email = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.email : ''));
  // change `multi-user`: «Пользователи» only for role admin
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  // claude-subscriptions P12: «Подписки» and «Расход» for every user, while the hub has the subscriptions API
  const hasSubs = useStore(s => s.subs !== null);
  // shown while the builds differ, whatever «Позже» said (design D5)
  const updatable = useUpdate(s => s.available && s.hub !== null);
  const go = (tab: SettingsTab) => {
    setOpen(false);
    openSettings(tab);
  };
  return (
    <div ref={box} className={`pm${variant === 'rail' ? ' tw-pm' : ''}`}>
      <button
        type="button"
        className={variant === 'rail' ? 'tw-ri' : 'icon-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Профиль"
        title="Профиль"
        data-tip={variant === 'rail' ? 'Профиль' : undefined}
        onClick={() => setOpen(!open)}
      >
        {variant === 'rail' ? IconDots : '⋯'}
      </button>
      {hiddenProjects && <HiddenProjects onClose={() => setHiddenProjects(false)} />}
      {/* phone: a bottom sheet over a scrim that stays under the toast stack (the banner keeps working) */}
      {open && <div className="pm-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="menu" role="menu" aria-label="Профиль">
          {email && <div className="m-title">{email}</div>}
          {updatable && (
            <button
              type="button"
              role="menuitem"
              className="m-upd"
              onClick={() => {
                if (requestUpdate()) setOpen(false);
              }}
            >
              <span className="u-dot" aria-hidden="true" />
              Обновить до новой версии
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              box.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
              setHiddenProjects(true);
            }}
          >
            Показать скрытые
          </button>
          <button type="button" role="menuitem" onClick={() => go('machines')}>
            Машины
          </button>
          {hasSubs && (
            <>
              <button type="button" role="menuitem" onClick={() => go('subscriptions')}>
                Подписки
              </button>
              <button type="button" role="menuitem" onClick={() => go('usage')}>
                Расход
              </button>
            </>
          )}
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => go('users')}>
              Пользователи
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => go('security')}>
            Безопасность
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Выйти
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              useDock.getState().reset();
            }}
          >
            Сбросить раскладку окон
          </button>
          <div className="m-sep" role="separator" />
          <Versions />
        </div>
      )}
    </div>
  );
}
