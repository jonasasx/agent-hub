/** Tray icon and menu (design D5, D12, D13, D15). Requirements: Счётчик ждущих сессий в трее; Меню трея. */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { HOTKEY_CHOICES, hotkeyMenuLabel } from '../core/hotkey.js';
import { menuStateKey, type TrayMenuState, type TrayView } from '../core/trayView.js';
import { dt } from '../core/i18n.js';

export type { TrayMenuState };

export interface TrayActions {
  toggleWindow(): void;
  showWindow(): void;
  hideWindow(): void;
  signIn(): void;
  setHotkey(accel: string | null): void;
  setAutostart(on: boolean): void;
  checkUpdates(): void;
  installUpdate(): void;
  quit(): void;
}

export class AppTray {
  private readonly tray: Tray;
  private iconName = '';
  private tooltip = '';
  /** Serialized TrayMenuState of the current context menu: the menu is rebuilt only when it changes. */
  private menuKey = '';

  constructor(
    private readonly assetsDir: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(this.image('tray-0'));
    this.tray.setToolTip('Agent Hub');
    this.tray.on('click', () => actions.toggleWindow());
  }

  private image(name: string) {
    return nativeImage.createFromPath(join(this.assetsDir, 'tray', `${name}.ico`));
  }

  render(view: TrayView, menu: TrayMenuState): void {
    if (view.icon !== this.iconName) {
      this.iconName = view.icon;
      this.tray.setImage(this.image(view.icon));
    }
    if (view.tooltip !== this.tooltip) {
      this.tooltip = view.tooltip;
      this.tray.setToolTip(view.tooltip);
    }
    const key = menuStateKey(menu);
    if (key !== this.menuKey) {
      this.menuKey = key;
      this.tray.setContextMenu(Menu.buildFromTemplate(this.template(menu)));
    }
  }

  private template(m: TrayMenuState): MenuItemConstructorOptions[] {
    const a = this.actions;
    const hotkeys: MenuItemConstructorOptions[] = [
      ...HOTKEY_CHOICES.map((accel): MenuItemConstructorOptions => ({ label: accel, type: 'radio', checked: m.hotkey === accel, click: () => a.setHotkey(accel) })),
      { label: dt('desktop.tray.hotkeyOff'), type: 'radio', checked: m.hotkey === null, click: () => a.setHotkey(null) },
    ];
    if (m.hotkey !== null && !HOTKEY_CHOICES.includes(m.hotkey)) {
      hotkeys.unshift({ label: dt('desktop.tray.hotkeyFromConfig', { hotkey: m.hotkey }), type: 'radio', checked: true, click: () => a.setHotkey(m.hotkey) });
    }
    const items: MenuItemConstructorOptions[] = [
      { label: `Agent Hub ${m.version}`, enabled: false },
      { type: 'separator' },
      m.windowVisible ? { label: dt('desktop.tray.hideWindow'), click: () => a.hideWindow() } : { label: dt('desktop.tray.showWindow'), click: () => a.showWindow() },
    ];
    if (m.signedOut) items.push({ label: dt('desktop.tray.signIn'), click: () => a.signIn() });
    items.push(
      { type: 'separator' },
      { label: hotkeyMenuLabel(m.hotkey, m.hotkeyRegistered), submenu: hotkeys },
      { label: dt('desktop.tray.autostart'), type: 'checkbox', checked: m.autostart, click: item => a.setAutostart(item.checked) },
      m.updateReady ? { label: dt('desktop.tray.restartUpdate'), click: () => a.installUpdate() } : { label: dt('desktop.tray.checkUpdates'), click: () => a.checkUpdates() },
      { type: 'separator' },
      { label: dt('desktop.tray.quit'), click: () => a.quit() },
    );
    return items;
  }

  destroy(): void {
    this.tray.destroy();
  }
}
