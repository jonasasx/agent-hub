// «Настройки → Сессии»: the default idle timeout of the user's sessions (change session-sleep-controls).
// A session with its own timeout keeps it; «Как в хабе» follows the hub's value. The choice is saved at once.
import { useEffect, useState } from 'react';
import { IDLE_TIMEOUT_CHOICES, type SessionPreferences } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { idleLabel } from '../workspace/actions';

export function SessionsPage() {
  const t = useT();
  const pushToast = useStore(s => s.pushToast);
  const [prefs, setPrefs] = useState<SessionPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  // one save at a time: a late failure of an older click would otherwise roll back a newer choice
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getSessionPreferences()
      .then(p => {
        if (alive) setPrefs(p);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const choose = async (idleTimeoutMin: number | null) => {
    if (busy || !prefs) return;
    setBusy(true);
    const prev = prefs;
    setPrefs({ ...prefs, idleTimeoutMin });
    try {
      setPrefs(await api.setSessionPreferences(idleTimeoutMin));
    } catch (e) {
      setPrefs(prev);
      const text = e instanceof ApiError && e.serverMessage ? e.serverMessage : t('workspace.actions.hubNoAnswer');
      pushToast({ title: t('settings.sessions.saveFailedTitle'), text, color: 'var(--bad)' });
    } finally {
      setBusy(false);
    }
  };

  const label = (m: number) => (m === 0 ? t('chat.idle.never') : t('chat.idle.choice', { label: idleLabel(m) }));

  return (
    <section aria-labelledby="set-sessions">
      <div className="set-head">
        <h2 id="set-sessions">{t('settings.sessions.title')}</h2>
      </div>
      <p className="hint">{t('settings.sessions.hint')}</p>
      {failed ? (
        <p className="hint" role="alert">
          {t('settings.sessions.loadFailed')}
        </p>
      ) : prefs ? (
        <div className="lang-list" role="radiogroup" aria-label={t('settings.sessions.group')} aria-busy={busy}>
          <label className={`lang-opt${prefs.idleTimeoutMin === null ? ' on' : ''}`}>
            <input type="radio" name="idle-default" checked={prefs.idleTimeoutMin === null} onChange={() => void choose(null)} />
            <span>{t('settings.sessions.hub', { label: idleLabel(prefs.hubIdleTimeoutMin) })}</span>
          </label>
          {IDLE_TIMEOUT_CHOICES.map(m => (
            <label key={m} className={`lang-opt${prefs.idleTimeoutMin === m ? ' on' : ''}`}>
              <input type="radio" name="idle-default" checked={prefs.idleTimeoutMin === m} onChange={() => void choose(m)} />
              <span>{label(m)}</span>
            </label>
          ))}
        </div>
      ) : null}
    </section>
  );
}
