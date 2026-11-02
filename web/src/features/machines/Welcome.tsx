/**
 * Requirement (runner-enrollment): Приветственный экран — a user without machines sees this instead of the work area,
 * without the left panel; one button «Подключить машину». Scenario «Первый вход».
 */
import { useStore } from '../../store';

export function Welcome({ onLogout }: { onLogout: () => void }) {
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
        <h1>{name ? `${name.split(' ')[0]}, добро пожаловать` : 'Добро пожаловать'}</h1>
        <p>Подключите машину, на которой будут работать ваши агенты: свой компьютер, сервер или ВМ.</p>
        <ul className="welcome-list">
          <li>одна команда в терминале — Linux, macOS или Windows;</li>
          <li>нужна подписка Claude: если входа нет, установщик предложит войти;</li>
          <li>ваши машины и сессии видите только вы.</li>
        </ul>
        <button type="button" className="btn primary welcome-cta" onClick={() => useStore.setState({ modal: { type: 'enroll' } })}>
          Подключить машину
        </button>
        <p className="welcome-foot">
          {email && <span>{email} · </span>}
          <button type="button" className="lnk" onClick={onLogout}>
            Выйти
          </button>
        </p>
      </div>
    </main>
  );
}
