/**
 * ChatGPT sign-in of Codex subscriptions and the CLI status of «Настройки → Машины» (change provider-parity, design D3,
 * D12). A Codex subscription is a device-code sign-in done on a machine through the hub: `CodexLoginFlow` (used on
 * «Подписки» to add a subscription or to sign in again) shows the link and the one-time code and waits for the WS
 * provider.login that carries the subscription id; «Отмена» cancels it on the machine. `ProviderStatusRow` on «Машины»
 * only shows the CLI version — there is no sign-in of its own there.
 * API: POST /api/subscriptions/codex-login, DELETE /api/runners/:id/providers/:p/login/:loginId.
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { PROVIDER_LABELS, type ExtraProvider, type ProviderLoginStartView, type RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { loadSubscriptions } from '../subscriptions/actions';

type LoginEnd = { runnerId: string; provider: ExtraProvider; loginId: string; ok: boolean; error?: string; subscriptionId?: string };
const listeners = new Set<(e: LoginEnd) => void>();

/** WS provider.login (workspace/actions.ts): the end of a sign-in, to the open flows. */
export function providerLoginArrived(e: LoginEnd): void {
  for (const l of listeners) l(e);
  if (e.ok && e.subscriptionId) void loadSubscriptions();
}

/** Online machines that can sign a Codex subscription in. */
export function codexRunners(runners: RunnerView[]): RunnerView[] {
  return runners.filter(r => r.online && r.providers?.some(p => p.id === 'codex'));
}

export function loginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'name_taken') return 'Подписка с таким именем уже есть';
    if (err.code === 'runner_offline') return 'Машина не в сети';
    if (err.code === 'agent_outdated') return 'Агент на машине устарел — обновите его';
    if (err.code === 'subscriptions_disabled') return 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY';
    if (err.serverMessage) return err.serverMessage;
  }
  return 'Вход не начат. Проверьте, что машина в сети.';
}

/**
 * The sign-in of one Codex subscription: `name` creates a new one, `subscriptionId` replaces the sign-in of an
 * existing one. `onStart` lets the caller check the name before anything leaves.
 */
export function CodexLoginFlow({ name, subscriptionId, label, onStart, onEnd }: { name?: string; subscriptionId?: string; label: string; onStart?: () => boolean; onEnd?: (ok: boolean) => void }) {
  const runners = codexRunners(useStore(s => s.runners));
  const [runnerId, setRunnerId] = useState('');
  const [flow, setFlow] = useState<{ view: ProviderLoginStartView; runnerId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const machine = runners.find(r => r.id === runnerId) ?? runners[0];

  useEffect(() => {
    const l = (e: LoginEnd) => {
      if (e.loginId !== flow?.view.loginId) return;
      setFlow(null);
      setMsg(e.ok ? { ok: true, text: 'Вход выполнен' } : { ok: false, text: `Вход не выполнен${e.error ? `: ${e.error}` : ''}` });
      onEnd?.(e.ok);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [flow?.view.loginId, onEnd]);

  const start = async () => {
    if (!machine || (onStart && !onStart())) return;
    setBusy(true);
    setMsg(null);
    setCopied(false);
    try {
      const view = await api.codexLogin({ runnerId: machine.id, ...(subscriptionId ? { subscriptionId } : { name: (name ?? '').trim() }) });
      setFlow({ view, runnerId: machine.id });
    } catch (err) {
      setMsg({ ok: false, text: loginError(err) });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const f = flow;
    setFlow(null);
    if (f) await api.providerLoginCancel(f.runnerId, 'codex', f.view.loginId).catch(() => undefined);
  };

  if (runners.length === 0) return <p className="hint">Нет машины в сети с установленным Codex — войти в ChatGPT не получится.</p>;
  return (
    <div className="prov-login">
      {!flow && (
        <div className="subs-edit-row">
          {runners.length > 1 && (
            <select className="input" aria-label="Машина для входа" value={machine?.id ?? ''} onChange={e => setRunnerId(e.target.value)}>
              {runners.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Запрашиваем код…' : label}
          </button>
        </div>
      )}
      {flow && (
        <div className="prov-flow" role="status">
          <span>
            Откройте{' '}
            <a href={flow.view.verificationUrl} target="_blank" rel="noreferrer">
              {flow.view.verificationUrl}
            </a>{' '}
            на любом устройстве, войдите в ChatGPT и введите код:
          </span>
          <span className="prov-code">
            <code>{flow.view.userCode}</code>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(flow.view.userCode).then(() => setCopied(true));
              }}
            >
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </span>
          <span className="hint">
            <span className="spinner" aria-hidden="true" /> Ждём подтверждения на {runners.find(r => r.id === flow.runnerId)?.name ?? 'машине'}…
          </span>
          <span>
            <button type="button" className="btn ghost" onClick={() => void cancel()}>
              Отмена
            </button>
          </span>
        </div>
      )}
      {msg && (
        <span className={msg.ok ? 'hint' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** The CLI of a provider on «Машины»: its version; the sign-in is a subscription now («Настройки → Подписки»). */
export function ProviderStatusRow({ r, provider }: { r: RunnerView; provider: ExtraProvider }) {
  const st = r.providers?.find(p => p.id === provider);
  if (!st) return null;
  return (
    <div className="prov-row">
      <dt>{PROVIDER_LABELS[provider]}</dt>
      <dd className="ag">
        <span className="mc-ver">{st.version ? <span className="num">{st.version}</span> : '—'}</span>
        <span className="hint">вход — в «Подписки»</span>
      </dd>
    </div>
  );
}
