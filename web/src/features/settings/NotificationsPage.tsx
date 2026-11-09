/**
 * «Настройки → Уведомления» (change web-push-notifications, design D8).
 * Requirements: Подписка устройства из настроек (status, «Включить» only by click, iOS hint, desktop app explanation),
 * Отписка и очистка подписок (list of devices, «Отключить»), API подписок (test notification).
 * API: GET/POST/DELETE /api/push/subscriptions, POST /api/push/test.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { PushDeviceView } from '../../api/types';
import { useT } from '../../i18n';
import { dateTime } from '../machines/machines';
import { disablePush, enablePush, pushStatus, type PushStatus } from '../push/pushClient';
import { useStore } from '../../store';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; devices: PushDeviceView[]; configured: boolean };
interface Here {
  status: PushStatus;
  hash: string | null;
}

export function NotificationsPage() {
  const t = useT();
  const vapid = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.vapidPublicKey : null));
  const userId = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.id : null));
  const pushToast = useStore(s => s.pushToast);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [here, setHere] = useState<Here | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.pushDevices();
      setLoad({ kind: 'ok', devices: r.devices, configured: r.configured });
      setHere(
        await pushStatus(
          vapid,
          r.devices.map(d => d.endpointHash),
        ),
      );
    } catch {
      setLoad({ kind: 'error' });
      setHere(await pushStatus(vapid, []));
    }
  }, [vapid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fail = (e: unknown) => {
    const text = e instanceof ApiError && e.serverMessage ? e.serverMessage : t('settings.common.hubNoAnswer');
    pushToast({ title: t('settings.push.toastFailed'), text, color: 'var(--bad)' });
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  // the permission dialog is opened by `enablePush`, called straight from this click
  const enable = () =>
    run(async () => {
      if (!vapid || !userId) return;
      const result = await enablePush(vapid, userId);
      if (result === 'enabled') pushToast({ title: t('settings.push.toastEnabled'), text: '', color: 'var(--ok)' });
    });
  const disable = () =>
    run(async () => {
      await disablePush();
      pushToast({ title: t('settings.push.toastDisabled'), text: '', color: 'var(--ok)' });
    });
  const sendTest = () =>
    run(async () => {
      if (!here?.hash) return;
      await api.testPush(here.hash);
      pushToast({ title: t('settings.push.toastTestSent'), text: '', color: 'var(--ok)' });
    });
  const remove = (d: PushDeviceView) =>
    run(async () => {
      await api.deletePushDevice(d.id);
      pushToast({ title: t('settings.push.toastRemoved'), text: '', color: 'var(--ok)' });
    });

  const status = here?.status ?? null;
  const devices = load.kind === 'ok' ? load.devices : [];
  const statusText: Partial<Record<PushStatus, string>> = {
    on: t('settings.push.statusOn'),
    off: t('settings.push.statusOff'),
    denied: t('settings.push.statusDenied'),
    unsupported: t('settings.push.statusUnsupported'),
    not_configured: t('settings.push.statusNotConfigured'),
  };
  const tone = status === 'on' ? 'ok' : status === 'denied' ? 'warn' : '';

  return (
    <section aria-labelledby="set-push">
      <div className="set-head">
        <h2 id="set-push">{t('settings.push.title')}</h2>
      </div>
      <p className="hint">{t('settings.push.hint')}</p>
      {status === null && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> {t('settings.common.loading')}
        </p>
      )}
      {status !== null && status !== 'ios_install' && status !== 'desktop_app' && (
        <p className="push-status" role="status">
          <span className={`tag ${tone}`}>{statusText[status]}</span>
        </p>
      )}
      {status === 'ios_install' && <p className="push-note">{t('settings.push.iosInstall')}</p>}
      {status === 'desktop_app' && <p className="push-note">{t('settings.push.desktopApp')}</p>}
      {status === 'denied' && <p className="hint">{t('settings.push.deniedHint')}</p>}
      {(status === 'off' || status === 'on') && (
        <div className="set-actions">
          {status === 'off' ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void enable()}>
              {t('settings.push.enable')}
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void disable()}>
                {t('settings.push.disable')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void sendTest()}>
                {t('settings.push.test')}
              </button>
            </>
          )}
        </div>
      )}
      {status !== 'not_configured' && (
        <>
          <h3 className="set-sub">{t('settings.push.devices')}</h3>
          {load.kind === 'error' && (
            <div className="err-box" role="alert">
              {t('settings.common.hubNoAnswer')}{' '}
              <button type="button" className="btn" onClick={() => void refresh()}>
                {t('settings.common.retry')}
              </button>
            </div>
          )}
          {load.kind === 'ok' && devices.length === 0 && <p className="empty-note">{t('settings.push.noDevices')}</p>}
          {devices.length > 0 && (
            <ul className="slist">
              {devices.map(d => {
                const mine = here?.hash === d.endpointHash;
                return (
                  <li key={d.id} className="srow-sec push-dev">
                    <div className="p-info">
                      <span>
                        <span className="s-br">{d.label}</span>
                        {mine && <span className="tag ok">{t('settings.push.thisDevice')}</span>}
                        {d.failureCount > 0 && <span className="tag bad">{t('settings.push.failing', { count: d.failureCount })}</span>}
                      </span>
                      <span className="s-at">{t('settings.push.connectedAt', { time: dateTime(d.createdAt) })}</span>
                      <span className="s-at">{d.lastSuccessAt ? t('settings.push.lastDelivery', { time: dateTime(d.lastSuccessAt) }) : t('settings.push.neverDelivered')}</span>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      aria-label={`${mine ? t('settings.push.disable') : t('settings.push.remove')}: ${d.label}`}
                      onClick={() => void (mine ? disable() : remove(d))}
                    >
                      {mine ? t('settings.push.disable') : t('settings.push.remove')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
