/**
 * Opening a tool window from the outside (a machine menu, a toast, a hotkey): the desktop restores a hidden window and
 * activates its slot tab; the phone shows it over the home screen.
 */
import type { WinId } from './dock';
import { useDock } from './useDock';
import { isPhoneNow } from './usePhone';
import { pushPhoneWindow } from '../workspace/phoneHistory';

export function openToolWindow(id: WinId): void {
  if (isPhoneNow()) {
    useDock.getState().setPhoneWin(id);
    pushPhoneWindow(id);
    return;
  }
  useDock.getState().show(id);
}
