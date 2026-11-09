/**
 * Texts of the limits UI (change subscription-limits, design.md L7 «Расшифровки»): constants of the interface, never
 * from the hub. A window is looked up by its key; an unknown key shows its raw name and no description.
 * Every text is resolved when it is asked for, so a change of the interface language applies at once.
 */
import type { LimitsReason } from '../../api/types';
import { t } from '../../i18n';

export interface WindowText {
  /** For the row and the chip: «5 h», «7 d». */
  short: string;
  /** For the card: «5 hours». */
  name: string;
  /** null — an unknown window. */
  desc: string | null;
}

const KNOWN_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_overage_included'] as const;
type KnownWindow = (typeof KNOWN_WINDOWS)[number];

export const isKnownWindow = (type: string): type is KnownWindow => (KNOWN_WINDOWS as readonly string[]).includes(type);

export const unknownWindowDesc = (): string => t('limits.window.unknownDesc');

export function windowText(type: string): WindowText {
  if (!isKnownWindow(type)) return { short: type, name: type, desc: null };
  return { short: t(`limits.window.${type}.short`), name: t(`limits.window.${type}.name`), desc: t(`limits.window.${type}.desc`) };
}

export const overageDesc = (): string => t('limits.text.overage');

export const exhaustionRules = (): string => t('limits.text.exhaustion');

export const refreshHint = (): string => t('limits.text.refresh');

export const quietText = (): string => t('limits.text.quiet');

/** A quiet check while a window holds its level (fix 2026-10-29). */
export const heldText = (): string => t('limits.text.held');

/** «no data: …» by reason; `agent_outdated` names the machines when they are known. */
export function reasonText(reason: LimitsReason | null, outdatedMachines: string[] = []): string {
  switch (reason) {
    case 'token_rejected':
      return t('limits.reason.token_rejected');
    case 'no_runner':
      return t('limits.reason.no_runner');
    case 'agent_outdated':
      return outdatedMachines.length ? t('limits.reason.agent_outdated_on', { machines: outdatedMachines.join(', ') }) : t('limits.reason.agent_outdated');
    case 'probe_failed':
      return t('limits.reason.probe_failed');
    case 'expired':
      return t('limits.reason.expired');
    case 'not_polled':
    case null:
    default:
      return t('limits.reason.not_polled');
  }
}

/** One sentence after «No data: …» in the card. */
export function reasonAdvice(reason: LimitsReason | null): string {
  switch (reason) {
    case 'token_rejected':
      return t('limits.advice.token_rejected');
    case 'no_runner':
      return t('limits.advice.no_runner');
    case 'agent_outdated':
      return t('limits.advice.agent_outdated');
    case 'probe_failed':
      return t('limits.advice.probe_failed');
    case 'expired':
      return t('limits.advice.expired');
    default:
      return t('limits.advice.default');
  }
}

/** Texts of refresh errors (design.md L6: 404, 409 …, 429, 503). */
export function refreshErrorText(code: string | null, status: number): string {
  switch (code) {
    case 'subscription_retired':
      return t('limits.refreshError.subscription_retired');
    case 'token_rejected':
      return t('limits.refreshError.token_rejected');
    case 'runner_offline':
      return t('limits.refreshError.runner_offline');
    case 'agent_outdated':
      return t('limits.refreshError.agent_outdated');
    case 'probes_disabled':
      return t('limits.refreshError.probes_disabled');
    case 'subscriptions_disabled':
      return t('limits.refreshError.subscriptions_disabled');
    default:
      return status === 404 ? t('limits.refreshError.notFound') : t('limits.refreshError.noAnswer');
  }
}
