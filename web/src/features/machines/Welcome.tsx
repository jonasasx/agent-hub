/**
 * Requirement (runner-enrollment): Приветственный экран — a user without machines sees this instead of the work area,
 * without the left panel; one button «Подключить машину». Scenario «Первый вход».
 */
import { useT } from '../../i18n';
import { useStore } from '../../store';

export function Welcome({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const email = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.email : ''));
  const name = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.name : null));
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
