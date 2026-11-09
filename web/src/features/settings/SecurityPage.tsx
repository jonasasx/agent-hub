/**
 * «Настройки → Безопасность» (change `multi-user`).
 * Requirement (public-access): Журнал безопасности и выход везде — logins (time, provider, address, browser), active
 * browser sessions, connections of the machines, issue and use of the enrollment codes over 90 days; «Выйти на всех
 * устройствах» ends every other session. Scenarios «Выход на всех устройствах», «Подключение машины в журнале».
 * API: GET /api/security, POST /api/auth/logout-all (D10).
 * keycloak-auth D5: «Управление входом» opens the provider account page (`me.accountUrl`): password, two-factor, linked accounts.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SECURITY_LOG_DAYS, type SecurityEventView, type SecurityResponse } from '../../api/types';
import { t, useT } from '../../i18n';
import { useStore } from '../../store';
import { dateTime } from '../machines/machines';
import { providerLabel } from './UsersPage';

/** «Chrome · Windows» from a user agent; the raw string when nothing is recognised. */
export function browserLabel(ua: string | null): string {
  if (!ua) return t('settings.security.browserUnknown');
  if (/AgentHub|Electron/i.test(ua)) return t('settings.security.browserApp');
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (!b && !os) return ua.slice(0, 60);
  return [b, os].filter(Boolean).join(' · ');
}

export function eventText(e: SecurityEventView): string {
  const machine = e.runner?.name ?? t('settings.security.machineFallback');
  const from = e.ip ? ` ${t('settings.security.from', { ip: e.ip })}` : '';
  switch (e.kind) {
    case 'login':
      return `${e.provider ? t('settings.security.event.loginVia', { provider: providerLabel(e.provider) }) : t('settings.security.event.login')}${from}`;
    case 'login_denied':
      return `${t('settings.security.event.loginDenied')}${from}`;
    case 'signup':
      return t('settings.security.event.signup');
    case 'logout_all':
      return t('settings.security.event.logoutAll');
    case 'runner_connected':
      return `${t('settings.security.event.runnerConnected', { machine })}${from}`;
    case 'runner_disconnected':
      return t('settings.security.event.runnerDisconnected', { machine });
    case 'enroll_code_issued':
      return t('settings.security.event.codeIssued', { machine });
    case 'enroll_code_used':
      return `${t('settings.security.event.codeUsed', { machine })}${from}`;
  }
}

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: SecurityResponse };

export function SecurityPage() {
  const tr = useT();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const pushToast = useStore(s => s.pushToast);
  const fetchAll = useCallback(() => {
    api
      .security()
      .then(data => setLoad({ kind: 'ok', data }))
      .catch(() => setLoad({ kind: 'error' }));
  }, []);
  useEffect(fetchAll, [fetchAll]);

  const logoutAll = async () => {
    setBusy(true);
    try {
      const r = await api.logoutAll();
      pushToast({
        title: tr('settings.security.loggedOut'),
        text: r.ended ? tr('settings.security.ended', { count: r.ended }) : tr('settings.security.noOthers'),
        color: 'var(--ok)',
      });
      fetchAll();
    } catch {
      pushToast({ title: tr('settings.security.failed'), text: tr('settings.common.hubNoAnswer'), color: 'var(--bad)' });
    } finally {
      setBusy(false);
    }
  };

  const accountUrl = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.accountUrl : null));
  const others = load.kind === 'ok' ? load.data.sessions.filter(s => !s.current).length : 0;
  return (
    <section aria-labelledby="set-security">
      <div className="set-head">
        <h2 id="set-security">{tr('settings.security.title')}</h2>
      </div>
      {accountUrl && (
        <div className="set-actions">
          <a className="btn" href={accountUrl} target="_blank" rel="noopener noreferrer">
            {tr('settings.security.manageSignIn')}
          </a>
          <span className="hint">{tr('settings.security.manageSignInHint')}</span>
        </div>
      )}
      {load.kind === 'loading' && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> {tr('settings.common.loading')}
        </p>
      )}
      {load.kind === 'error' && (
        <div className="err-box" role="alert">
          {tr('settings.security.loadError')}{' '}
          <button type="button" className="btn" onClick={fetchAll}>
            {tr('settings.common.retry')}
          </button>
        </div>
      )}
      {load.kind === 'ok' && (
        <>
          <h3 className="set-sub">{tr('settings.security.sessions')}</h3>
          <ul className="slist">
            {load.data.sessions.map(s => (
              <li key={s.id} className="srow-sec">
                <span className="s-br">{browserLabel(s.userAgent)}</span>
                {s.current && <span className="tag ok">{tr('settings.security.thisDevice')}</span>}
                <span className="s-at">{tr('settings.security.signedInAt', { at: dateTime(s.createdAt) })}</span>
              </li>
            ))}
          </ul>
          <div className="set-actions">
            <button type="button" className="btn" disabled={busy || !others} onClick={() => void logoutAll()}>
              {busy ? tr('settings.security.logoutBusy') : tr('settings.security.logoutAll')}
            </button>
            <span className="hint">{others ? tr('settings.security.logoutKept') : tr('settings.security.logoutNone')}</span>
          </div>
          <h3 className="set-sub">{tr('settings.security.log', { count: SECURITY_LOG_DAYS })}</h3>
          {load.data.events.length ? (
            <ul className="elist">
              {load.data.events.map(e => (
                <li key={e.id} className={`erow ${e.kind}`}>
                  <time className="e-at" dateTime={e.at}>
                    {dateTime(e.at)}
                  </time>
                  <span className="e-text">{eventText(e)}</span>
                  {e.userAgent && (e.kind === 'login' || e.kind === 'login_denied') && <span className="e-ua">{browserLabel(e.userAgent)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">{tr('settings.security.logEmpty')}</p>
          )}
        </>
      )}
    </section>
  );
}
