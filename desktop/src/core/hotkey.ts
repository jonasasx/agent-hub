/** Global hotkey choices (design D12). Requirement: Глобальная горячая клавиша. */

export const HOTKEY_DEFAULT = 'Ctrl+Alt+Space';

/** Offered in the tray menu; «Отключить» is `null`. */
export const HOTKEY_CHOICES: readonly string[] = ['Ctrl+Alt+Space', 'Ctrl+Alt+A', 'Ctrl+Shift+Space', 'Ctrl+Alt+H'];

export function conflictMessage(accel: string): string {
  return `Сочетание ${accel} занято другой программой — выберите другое в меню трея`;
}

/** Label of the tray submenu: the current state of the hotkey. */
export function hotkeyMenuLabel(hotkey: string | null, registered: boolean): string {
  if (hotkey === null) return 'Горячая клавиша: отключена';
  return registered ? `Горячая клавиша: ${hotkey}` : 'Горячая клавиша: не назначена';
}
