/**
 * The profile menu: versions and the entries that lead to the settings. In the left rail (desktop) and in the top bar of
 * the phone shell (UI review L7: sign-out lives here, not next to the theme switch).
 * profile-menu-grouping (spec profile-menu): a header with the account, the groups «Настройки» and «Рабочее место»,
 * «Выйти» apart at the bottom and a one-line versions summary; the layout reset asks for a confirmation inside the menu.
 */
import { useEffect, useRef, useState } from 'react';
import { useMenu } from '../ui/a11y';
import { useStore } from '../../store';
import { openSettings } from '../settings/Settings';
import { availablePages, pageIcon, type SettingsPage } from '../settings/pages';
import { openHiddenProjects } from '../projects/hiddenGroups';
import { requestUpdate, useUpdate } from '../update/check';
import { formatBuild, sameBuild } from '../update/buildInfo';
import { desktopVersion } from '../update/desktopVersion';
import { useDock } from '../toolwindows/useDock';
import { IconDots, profileIcon } from '../toolwindows/icons';
import { useT } from '../../i18n';

/**
 * Versions at the bottom of the profile menu (change client-versions, spec «Версии в меню профиля»): one line — «Клиент =
 * Хаб <сборка>» or both builds when they differ — and «подробнее» with the client, the hub («—» until it answers) and,
 * in the desktop app, the app's version from the user-agent.
 */
function Versions() {
  const t = useT();
  const client = useUpdate(s => s.client);
  const hub = useUpdate(s => s.hub);
  const [expanded, setExpanded] = useState(false);
  const app = desktopVersion();
  const differ = hub !== null && !sameBuild(client, hub);
  const line =
    hub && !differ ? t('workspace.sidebar.versionsSame', { build: formatBuild(client) }) : t('workspace.sidebar.versionsDiffer', { client: formatBuild(client), hub: hub ? formatBuild(hub) : '—' });
  return (
    <div className="m-ver-box">
      <div className={`m-ver-line${differ ? ' warn' : ''}`}>
        <span>{line}</span>
        <button type="button" className="m-ver-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t('workspace.sidebar.versionsLess') : t('workspace.sidebar.versionsMore')}
        </button>
      </div>
      {expanded && (
        <dl className="m-ver" aria-label={t('workspace.sidebar.versions')}>
          <dt>{t('workspace.sidebar.versionClient')}</dt>
          <dd>{formatBuild(client)}</dd>
          <dt>{t('workspace.sidebar.versionHub')}</dt>
          <dd>{hub ? formatBuild(hub) : '—'}</dd>
          {app && (
            <>
              <dt>{t('workspace.sidebar.versionApp')}</dt>
              <dd>{app}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

/** The pages «Настройки» of the menu, in this order; the rest are behind «Все настройки». */
const MENU_PAGES: {
  id: SettingsPage;
  label: 'workspace.sidebar.machines' | 'workspace.sidebar.subscriptions' | 'workspace.sidebar.usage' | 'workspace.sidebar.users' | 'workspace.sidebar.security';
}[] = [
  { id: 'machines', label: 'workspace.sidebar.machines' },
  { id: 'subscriptions', label: 'workspace.sidebar.subscriptions' },
  { id: 'usage', label: 'workspace.sidebar.usage' },
  { id: 'users', label: 'workspace.sidebar.users' },
  { id: 'security', label: 'workspace.sidebar.security' },
];

/** «⋯»: `rail` — the button of the left rail (a tool-window rail icon), otherwise the button of the panel header. */
export function ProfileMenu({ onLogout, variant = 'top' }: { onLogout: () => void; variant?: 'top' | 'rail' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setConfirmReset(false);
  };
  useMenu(open, box, close);
  const email = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.email : ''));
  // change `multi-user`: «Пользователи» only for role admin
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  // claude-subscriptions P12: «Подписки» and «Расход» for every user, while the hub has the subscriptions API
  const hasSubs = useStore(s => s.subs !== null);
  const hasDesktop = useStore(s => !!s.desktopInfo?.available);
  // shown while the builds differ, whatever «Позже» said (design D5)
  const updatable = useUpdate(s => s.available && s.hub !== null);
  const pages = availablePages({ isAdmin, hasSubs, hasDesktop });
  const shown = MENU_PAGES.filter(m => pages.some(p => p.id === m.id));
  useEffect(() => {
    if (confirmReset) cancel.current?.focus();
  }, [confirmReset]);
  const go = (tab: SettingsPage | 'index') => {
    close();
    openSettings(tab);
  };
  const focusTrigger = () => box.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
  return (
    <div ref={box} className={`pm${variant === 'rail' ? ' tw-pm' : ''}`}>
      <button
        type="button"
        className={variant === 'rail' ? 'tw-ri' : 'icon-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspace.sidebar.profile')}
        title={t('workspace.sidebar.profile')}
        data-tip={variant === 'rail' ? t('workspace.sidebar.profile') : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {variant === 'rail' ? IconDots : '⋯'}
      </button>
      {/* phone: a bottom sheet over a scrim that stays under the toast stack (the banner keeps working) */}
      {open && <div className="pm-scrim" aria-hidden="true" onClick={close} />}
      {open && (
        <div className="menu pm-menu" role="menu" aria-label={t('workspace.sidebar.profile')}>
          {email && (
            <div className="m-head">
              <span className="m-avatar" aria-hidden="true">
                {email.charAt(0).toUpperCase()}
              </span>
              <span className="m-who">
                <span className="m-email">{email}</span>
                <span className="m-role">{isAdmin ? t('workspace.sidebar.roleAdmin') : t('workspace.sidebar.roleUser')}</span>
              </span>
            </div>
          )}
          {updatable && (
            <button
              type="button"
              role="menuitem"
              className="m-upd"
              onClick={() => {
                if (requestUpdate()) close();
              }}
            >
              <span className="u-dot" aria-hidden="true" />
              {t('workspace.sidebar.updateNow')}
            </button>
          )}
          <div className="m-group" role="presentation">
            <div className="m-group-h" role="presentation">
              {t('workspace.sidebar.groupSettings')}
            </div>
            {shown.map(m => (
              <button key={m.id} type="button" role="menuitem" onClick={() => go(m.id)}>
                <span className="m-ic" aria-hidden="true">
                  {pageIcon(m.id)}
                </span>
                {t(m.label)}
              </button>
            ))}
            <button type="button" role="menuitem" onClick={() => go('index')}>
              <span className="m-ic" aria-hidden="true">
                {profileIcon('gear')}
              </span>
              {t('workspace.sidebar.allSettings')}
              <span className="m-count">{pages.length}</span>
            </button>
          </div>
          <div className="m-group" role="presentation">
            <div className="m-group-h" role="presentation">
              {t('workspace.sidebar.groupWorkspace')}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                focusTrigger();
                openHiddenProjects();
              }}
            >
              <span className="m-ic" aria-hidden="true">
                {profileIcon('eyeoff')}
              </span>
              {t('workspace.sidebar.showHidden')}
            </button>
            {confirmReset ? (
              <div className="m-confirm" role="group" aria-label={t('workspace.sidebar.resetConfirm')}>
                <span className="m-confirm-q">{t('workspace.sidebar.resetConfirm')}</span>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    close();
                    focusTrigger();
                    useDock.getState().reset();
                  }}
                >
                  {t('workspace.sidebar.resetConfirmYes')}
                </button>
                <button type="button" role="menuitem" ref={cancel} onClick={() => setConfirmReset(false)}>
                  {t('workspace.sidebar.resetConfirmNo')}
                </button>
              </div>
            ) : (
              <button type="button" role="menuitem" onClick={() => setConfirmReset(true)}>
                <span className="m-ic" aria-hidden="true">
                  {profileIcon('reset')}
                </span>
                {t('workspace.sidebar.resetLayout')}
              </button>
            )}
          </div>
          <div className="m-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="m-out"
            onClick={() => {
              close();
              onLogout();
            }}
          >
            <span className="m-ic" aria-hidden="true">
              {profileIcon('logout')}
            </span>
            {t('workspace.sidebar.signOut')}
          </button>
          <Versions />
        </div>
      )}
    </div>
  );
}
