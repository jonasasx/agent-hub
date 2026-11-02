/**
 * «Настройки → Пользователи» — only for role admin (change `multi-user`).
 * Requirement (users): Приглашение — address and provider, the link with «Скопировать», the list of invites (address,
 * provider, term, used), revoking an unused one; scenarios «Создание приглашения», «Повторное приглашение того же
 * адреса», «Приглашение на адрес существующего пользователя». Requirement: Отключение пользователя (not oneself).
 * Requirement: Администратор не видит чужие сессии — per user only the aggregates «2 машины, 1 в сети».
 * API: GET/POST/DELETE /api/admin/invites, GET /api/admin/users, POST /api/admin/users/:id/disable|enable (D10).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { AdminUserView, CreateInviteResponse, InviteView, LoginProvider } from '../../api/types';
import { useStore } from '../../store';
import { CommandBox } from '../machines/EnrollModal';
import { dateTime, plural } from '../machines/machines';
import { useUnsavedInput } from '../update/unsaved';

export const PROVIDER_LABEL: Record<LoginProvider, string> = { google: 'Google', keycloak: 'Keycloak' };

const INVITE_STATUS: Record<InviteView['status'], string> = { active: 'действует', used: 'использовано', expired: 'истекло', revoked: 'отозвано' };

/** «2 машины, 1 в сети», «нет машин». */
export function machinesText(m: AdminUserView['machines']): string {
  if (!m.total) return 'нет машин';
  return `${m.total} ${plural(m.total, ['машина', 'машины', 'машин'])}, ${m.online} в сети`;
}

/** «7 дней», «3 часа» до expiresAt. */
export function termLeft(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'истекло';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${Math.round(ms / 86_400_000)} ${plural(Math.round(ms / 86_400_000), ['день', 'дня', 'дней'])}`;
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return `${h} ${plural(h, ['час', 'часа', 'часов'])}`;
}

function InviteForm({ onCreated }: { onCreated: (r: CreateInviteResponse) => void }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState<LoginProvider>('google');
  useUnsavedInput(email.trim() !== '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return setErr('Введите адрес почты');
    setBusy(true);
    setErr(null);
    try {
      onCreated(await api.createInvite({ email: v, provider }));
      setEmail('');
    } catch (e2) {
      setErr(
        e2 instanceof ApiError && e2.code === 'user_exists'
          ? 'Пользователь уже есть'
          : e2 instanceof ApiError && e2.status === 400
            ? 'Адрес не похож на почту'
            : 'Приглашение не создано. Попробуйте ещё раз.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="invite-form" onSubmit={e => void submit(e)} noValidate>
      <div className="field">
        <label htmlFor={`${id}-email`}>Почта</label>
        <input
          id={`${id}-email`}
          className="input"
          type="email"
          autoComplete="off"
          placeholder="name@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          aria-invalid={!!err}
          aria-describedby={err ? `${id}-err` : undefined}
        />
      </div>
      <div className="field">
        <span className="lbl" id={`${id}-p`}>
          Вход через
        </span>
        <div className="segmini" role="radiogroup" aria-labelledby={`${id}-p`}>
          {(['google', 'keycloak'] as const).map(p => (
            <button key={p} type="button" role="radio" aria-checked={provider === p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Создаём…' : 'Пригласить'}
      </button>
      {err && (
        <span className="field-error" id={`${id}-err`} role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

function UserRow({ u, self, onChange }: { u: AdminUserView; self: boolean; onChange: (u: AdminUserView) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await api.setUserEnabled(u.id, enabled));
      setConfirm(false);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'cannot_disable_self' ? 'Себя отключить нельзя' : 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };
  const off = u.status === 'disabled';
  return (
    <li className={`urow${off ? ' disabled' : ''}`} aria-label={u.email}>
      <div className="u-main">
        <b className="u-name">{u.name ?? u.email}</b>
        {u.name && <span className="u-mail">{u.email}</span>}
        <span className="u-tags">
          <span className="tag">{PROVIDER_LABEL[u.provider]}</span>
          {u.role === 'admin' && <span className="tag">админ</span>}
          {off && <span className="tag bad">отключён</span>}
          {self && <span className="tag">это вы</span>}
        </span>
      </div>
      <dl className="u-facts">
        <div>
          <dt>Машины</dt>
          <dd>{machinesText(u.machines)}</dd>
        </div>
        <div>
          <dt>Приглашён</dt>
          <dd>{u.invitedAt ? dateTime(u.invitedAt) : '—'}</dd>
        </div>
        <div>
          <dt>Последний вход</dt>
          <dd>{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'ещё не входил'}</dd>
        </div>
      </dl>
      {!self && (
        <div className="u-actions">
          {off ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void toggle(true)}>
              Включить
            </button>
          ) : confirm ? (
            <div className="banner warn inline-warn" role="alertdialog" aria-label={`Отключить ${u.email}?`}>
              <div className="b-text">
                <b>Отключить {u.name ?? u.email}?</b> Его окна закроются, машины отключатся. Данные сохранятся, включить можно снова.
              </div>
              <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
                Отмена
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void toggle(false)}>
                Отключить
              </button>
            </div>
          ) : (
            <button type="button" className="btn ghost danger-text" onClick={() => setConfirm(true)}>
              Отключить
            </button>
          )}
        </div>
      )}
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
    </li>
  );
}

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; users: AdminUserView[]; invites: InviteView[] };

export function UsersPage() {
  const meId = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.id : ''));
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const fetchAll = useCallback(() => {
    Promise.all([api.adminUsers(), api.invites()])
      .then(([u, i]) => setLoad({ kind: 'ok', users: u.users, invites: i.invites }))
      .catch(() => setLoad({ kind: 'error' }));
  }, []);
  useEffect(fetchAll, [fetchAll]);

  const onCreated = (r: CreateInviteResponse) => {
    setCreated(r);
    // the hub revokes an earlier active invite of the address: the list comes again
    api
      .invites()
      .then(i => setLoad(l => (l.kind === 'ok' ? { ...l, invites: i.invites } : l)))
      .catch(() => setLoad(l => (l.kind === 'ok' ? { ...l, invites: [r.invite, ...l.invites] } : l)));
  };
  const revoke = async (inv: InviteView) => {
    setInviteErr(null);
    try {
      await api.revokeInvite(inv.id);
      if (created?.invite.id === inv.id) setCreated(null);
      setLoad(l => (l.kind === 'ok' ? { ...l, invites: l.invites.map(x => (x.id === inv.id ? { ...x, status: 'revoked', revokedAt: new Date().toISOString() } : x)) } : l));
    } catch (e) {
      setInviteErr(e instanceof ApiError && e.code === 'invite_used' ? 'Приглашение уже использовано' : 'Не отозвано. Попробуйте ещё раз.');
    }
  };

  return (
    <section aria-labelledby="set-users">
      <div className="set-head">
        <h2 id="set-users">Пользователи</h2>
      </div>
      <p className="hint">Вход только по приглашению. Сессии, машины и проекты пользователей вам не видны — только их число.</p>

      <h3 className="set-sub">Пригласить</h3>
      <InviteForm onCreated={onCreated} />
      {created && (
        <div className="invite-link" role="status">
          <p>
            Ссылка для <b>{created.invite.email}</b> · вход через {PROVIDER_LABEL[created.invite.provider]} · действует {termLeft(created.invite.expiresAt)}, одноразовая. Перешлите её сами — больше
            она не покажется.
          </p>
          <CommandBox command={created.url} label={`Ссылка-приглашение для ${created.invite.email}`} />
        </div>
      )}

      {load.kind === 'loading' && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> Загрузка…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="err-box" role="alert">
          Список не загружен.{' '}
          <button type="button" className="btn" onClick={fetchAll}>
            Повторить
          </button>
        </div>
      )}
      {load.kind === 'ok' && (
        <>
          <h3 className="set-sub">Приглашения</h3>
          {inviteErr && (
            <div className="err-box" role="alert">
              {inviteErr}
            </div>
          )}
          {load.invites.length ? (
            <ul className="ilist">
              {load.invites.map(i => (
                <li key={i.id} className={`irow ${i.status}`}>
                  <span className="i-mail">{i.email}</span>
                  <span className="tag">{PROVIDER_LABEL[i.provider]}</span>
                  <span className="i-st">
                    {i.status === 'active' ? `действует ещё ${termLeft(i.expiresAt)}` : i.status === 'used' ? `использовано ${dateTime(i.usedAt)}` : INVITE_STATUS[i.status]}
                  </span>
                  {i.status === 'active' && (
                    <button type="button" className="btn ghost danger-text" onClick={() => void revoke(i)} aria-label={`Отозвать приглашение ${i.email}`}>
                      Отозвать
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">Приглашений пока нет.</p>
          )}
          <h3 className="set-sub">Пользователи · {load.users.length}</h3>
          <ul className="ulist">
            {load.users.map(u => (
              <UserRow key={u.id} u={u} self={u.id === meId} onChange={nu => setLoad(l => (l.kind === 'ok' ? { ...l, users: l.users.map(x => (x.id === nu.id ? nu : x)) } : l))} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
