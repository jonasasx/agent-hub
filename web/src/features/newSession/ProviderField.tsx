/**
 * «Агент» of the new-session and handoff forms (change agent-providers, design D12): Claude Code or Codex. Codex is
 * offered when the machine reported it signed in; otherwise the option is disabled with the reason. The models of the
 * chosen provider: Claude — the hub's list, Codex — the machine's report.
 */
import { t, useT } from '../../i18n';
import { PROVIDER_LABELS, PROVIDERS, type ModelOption, type Provider, type RunnerView } from '../../api/types';

/** Why a provider is not offered on the machine; null — it is. */
export function providerUnavailable(r: RunnerView | undefined, p: Provider): string | null {
  if (p === 'claude' || !r) return null;
  const st = r.providers?.find(x => x.id === p);
  if (!st) return t('newSession.provider.missing');
  return null;
}

/** The models of a provider on a machine. */
export function providerModels(r: RunnerView | undefined, p: Provider, claudeModels: ModelOption[]): ModelOption[] {
  if (p === 'claude') return claudeModels;
  return r?.providers?.find(x => x.id === p)?.models ?? [];
}

/** «ChatGPT: почта · тариф» of the machine's Codex sign-in. */
export function accountLine(r: RunnerView | undefined, p: Provider): string | null {
  const a = r?.providers?.find(x => x.id === p)?.account;
  if (!a) return null;
  return [a.email, a.plan].filter(Boolean).join(' · ') || null;
}

export function ProviderField({ id, runner, value, onChange }: { id: string; runner: RunnerView | undefined; value: Provider; onChange: (p: Provider) => void }) {
  useT();
  return (
    <div className="field">
      <span className="lbl" id={`${id}-lbl`}>
        {t('newSession.provider.label')}
      </span>
      <div className="runner-opts" role="radiogroup" aria-labelledby={`${id}-lbl`}>
        {PROVIDERS.map(p => {
          const why = providerUnavailable(runner, p);
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === value}
              className={`seg-opt${p === value ? ' on' : ''}`}
              disabled={!!why}
              onClick={() => onChange(p)}
              title={why ?? undefined}
            >
              <b>{PROVIDER_LABELS[p]}</b>
              <span>{why ?? (p === 'claude' ? 'Anthropic' : (accountLine(runner, p) ?? 'OpenAI'))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
