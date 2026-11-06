/** Global hotkey choices (design D12). Requirement: Глобальная горячая клавиша. */
import { dt } from './i18n.js';

export const HOTKEY_DEFAULT = 'Ctrl+Alt+Space';

/** Offered in the tray menu; «Отключить» is `null`. */
export const HOTKEY_CHOICES: readonly string[] = ['Ctrl+Alt+Space', 'Ctrl+Alt+A', 'Ctrl+Shift+Space', 'Ctrl+Alt+H'];

export function conflictMessage(accel: string): string {
  return dt('desktop.hotkey.conflict', { accel });
}

/** Label of the tray submenu: the current state of the hotkey. */
export function hotkeyMenuLabel(hotkey: string | null, registered: boolean): string {
  if (hotkey === null) return dt('desktop.hotkey.disabled');
  return registered ? dt('desktop.hotkey.active', { hotkey }) : dt('desktop.hotkey.unassigned');
}
