/**
 * «Настройки → Безопасность» (change `multi-user`).
 * Requirement (public-access): Журнал безопасности и выход везде — logins (time, provider, address, browser), active
 * browser sessions, connections of the machines, issue and use of the enrollment codes over 90 days; «Выйти на всех
 * устройствах» ends every other session. Scenarios «Выход на всех устройствах», «Подключение машины в журнале».
 * API: GET /api/security, POST /api/auth/logout-all (D10).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SECURITY_LOG_DAYS, type SecurityEventView, type SecurityResponse } from '../../api/types';
import { useStore } from '../../store';
import { dateTime, plural } from '../machines/machines';
import { PROVIDER_LABEL } from './UsersPage';

/** «Chrome · Windows» from a user agent; the raw string when nothing is recognised. */
export function browserLabel(ua: string | null): string {
  if (!ua) return 'неизвестный браузер';
  if (/AgentHub|Electron/i.test(ua)) return 'приложение Agent Hub';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (!b && !os) return ua.slice(0, 60);
  return [b, os].filter(Boolean).join(' · ');
}

export function eventText(e: SecurityEventView): string {
  const m = e.runner?.name ?? 'машина';
  const from = e.ip ? ` с адреса ${e.ip}` : '';
  switch (e.kind) {
    case 'login':
      return `Вход${e.provider ? ` через ${PROVIDER_LABEL[e.provider]}` : ''}${from}`;
    case 'login_denied':
      return `Отказ во входе${from}`;
    case 'logout_all':
      return 'Выход на всех устройствах';
    case 'runner_connected':
      return `Подключена машина ${m}${from}`;
    case 'runner_disconnected':
      return `Отключилась машина ${m}`;
    case 'enroll_code_issued':
      return `Выдан код подключения для ${m}`;
    case 'enroll_code_used':
      return `Код подключения ${m} использован${from}`;
  }
}

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: SecurityResponse };

export function SecurityPage() {
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
        title: 'Выход выполнен',
        text: r.ended ? `Завершено ${r.ended} ${plural(r.ended, ['сеанс', 'сеанса', 'сеансов'])} на других устройствах` : 'Других активных сеансов не было',
        color: 'var(--ok)',
      });
      fetchAll();
    } catch {
      pushToast({ title: 'Не получилось', text: 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.', color: 'var(--bad)' });
    } finally {
      setBusy(false);
    }
  };

  const others = load.kind === 'ok' ? load.data.sessions.filter(s => !s.current).length : 0;
  return (
    <section aria-labelledby="set-security">
      <div className="set-head">
        <h2 id="set-security">Безопасность</h2>
      </div>
      {load.kind === 'loading' && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> Загрузка…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="err-box" role="alert">
          Журнал не загружен.{' '}
          <button type="button" className="btn" onClick={fetchAll}>
            Повторить
          </button>
        </div>
      )}
      {load.kind === 'ok' && (
        <>
          <h3 className="set-sub">Активные сеансы</h3>
          <ul className="slist">
            {load.data.sessions.map(s => (
              <li key={s.id} className="srow-sec">
                <span className="s-br">{browserLabel(s.userAgent)}</span>
                {s.current && <span className="tag ok">это устройство</span>}
                <span className="s-at">вход {dateTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
          <div className="set-actions">
            <button type="button" className="btn" disabled={busy || !others} onClick={() => void logoutAll()}>
              {busy ? 'Выходим…' : 'Выйти на всех устройствах'}
            </button>
            <span className="hint">{others ? 'Это устройство останется в системе.' : 'Других активных сеансов нет.'}</span>
          </div>
          <h3 className="set-sub">Журнал за {SECURITY_LOG_DAYS} дней</h3>
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
            <p className="empty-note">Записей пока нет.</p>
          )}
        </>
      )}
    </section>
  );
}
