/**
 * Machines of the user (change `multi-user`, spec runner-enrollment): the OS guessed from the browser, the OS family of
 * a runner, the commands shown in the enrollment window and on «Машины» and copying to the clipboard.
 */
import type { EnrollStage, MachineOs, RunnerView } from '../../api/types';
import { fmt } from '../../i18n';

export const OS_LABEL: Record<MachineOs, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
export const OS_ORDER: MachineOs[] = ['linux', 'macos', 'windows'];

type Nav = { userAgent?: string; userAgentData?: { platform?: string } | undefined };

/** Requirement: Окно подключения машины — «ОС предвыбрана по браузеру». Phones fall back to Linux (a server). */
export function detectOs(nav: Nav = navigator as Nav): MachineOs {
  const platform = nav.userAgentData?.platform?.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform) return 'linux';
  const ua = nav.userAgent ?? '';
  if (/iphone|ipad|android/i.test(ua)) return 'linux';
  if (/mac os x|macintosh/i.test(ua)) return 'macos';
  if (/windows/i.test(ua)) return 'windows';
  return 'linux';
}

/** The OS family of a runner by its `os` text from hello («Windows 11 Pro», «macOS 15.1», «Ubuntu 24.04»). */
export function osFamily(os: string | null | undefined): MachineOs {
  const s = (os ?? '').toLowerCase();
  if (/win/.test(s)) return 'windows';
  if (/mac|darwin/.test(s)) return 'macos';
  return 'linux';
}

/** Requirement: Экран «Машины» — scenario «Нет входа в Claude». */
export function claudeLoginCommand(os: string | null | undefined): string {
  return osFamily(os) === 'windows' ? 'agent-hub login' : '~/.agent-hub/bin/agent-hub login';
}

export const needsClaudeLogin = (r: RunnerView | undefined) => !!r && (r.claudeLogin === 'missing' || r.claudeLogin === 'rejected');

/** The order of the enrollment stages for the progress list. */
export const STAGE_INDEX: Record<EnrollStage, number> = { waiting: 0, code_used: 1, connected: 2, claude_checked: 3, ready: 4 };

/** Copies text; false when the browser refuses (no clipboard API outside a secure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** «27.10.2026 06:41» in the browser time zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${fmt.date(d, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${fmt.time(d)}`;
}
