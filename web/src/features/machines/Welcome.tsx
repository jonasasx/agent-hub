/**
 * Requirement (runner-enrollment): Приветственный экран — a user without machines sees this instead of the work area,
 * without the left panel; one button «Подключить машину». Scenario «Первый вход».
 * desktop-download (change desktop-menu-entry): the profile menu is not shown here, so the screen links to the installers.
 */
import { useEffect } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { openSettings } from '../settings/Settings';
import { isDesktopApp } from '../voice/recorder';

export function Welcome({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const email = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.email : ''));
  const name = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.name : null));
  const desktopInfo = useStore(s => s.desktopInfo);
  const canDownload = !!desktopInfo?.available && !isDesktopApp();
  useEffect(() => {
    if (desktopInfo !== null || isDesktopApp()) return;
    api.desktopInfo().then(
      info => useStore.setState({ desktopInfo: info }),
      () => useStore.setState({ desktopInfo: { available: false } }),
    );
  }, [desktopInfo]);
  return (
    <main className="screen welcome">
      <div className="card">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ah
          </div>
          Agent Hub
        </div>
        <h1>{name ? t('machines.welcome.titleNamed', { name: name.split(' ')[0]! }) : t('machines.welcome.title')}</h1>
        <p>{t('machines.welcome.lead')}</p>
        <ul className="welcome-list">
          <li>{t('machines.welcome.item1')}</li>
          <li>{t('machines.welcome.item2')}</li>
          <li>{t('machines.welcome.item3')}</li>
        </ul>
        <button type="button" className="btn primary welcome-cta" onClick={() => useStore.setState({ modal: { type: 'enroll' } })}>
          {t('machines.welcome.cta')}
        </button>
        {canDownload && (
          <p className="welcome-desktop">
            <button type="button" className="lnk" onClick={() => openSettings('desktop')}>
              {t('machines.welcome.desktop')}
            </button>
          </p>
        )}
        <p className="welcome-foot">
          {email && <span>{email} · </span>}
          <button type="button" className="lnk" onClick={onLogout}>
            {t('machines.welcome.logout')}
          </button>
        </p>
      </div>
    </main>
  );
}
