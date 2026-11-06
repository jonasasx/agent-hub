/**
 * Entry points from the tool windows into the existing machine settings (Requirement «Окно „Машины“»: «MCP-серверы» and
 * «Настройки машины» of the machine menu): the Settings → Машины page opens and its card of the machine is scrolled
 * into view and focused.
 */
import { openSettings } from '../settings/Settings';

const TRIES = 20;

/** The page renders after the tab switch, so the card is looked for for a few frames. */
function focusCard(runnerId: string, left: number): void {
  const card = document.querySelector<HTMLElement>(`[data-runner="${CSS.escape(runnerId)}"]`);
  if (card) {
    card.scrollIntoView?.({ block: 'center' });
    card.focus({ preventScroll: true });
    return;
  }
  if (left > 0) requestAnimationFrame(() => focusCard(runnerId, left - 1));
}

export function openMachineSettings(runnerId: string): void {
  openSettings('machines');
  requestAnimationFrame(() => focusCard(runnerId, TRIES));
}
