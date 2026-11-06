/**
 * The registry of the tool windows: the title, the rail icon, the header actions and the body of each. A fifth window
 * is one entry here plus its id in `dock.ts`. `fit` windows take the height of their content (docs/prototypes/tool-windows.html FIT).
 */
import type { ComponentType, ReactNode } from 'react';
import { useStore } from '../../store';
import { FilesWindow } from '../files/FilesWindow';
import { MachinesWindow } from '../machines/MachinesWindow';
import { refreshLimits } from '../limits/actions';
import { SubscriptionsWindow } from '../limits/SubscriptionsWindow';
import { SessionsWindow } from '../sidebar/SessionsWindow';
import type { WinId } from './dock';
import { WIN_TITLE } from './dock';
import { IconPlus, IconRefresh, IconSearch } from './icons';
import { t } from '../../i18n';

export interface HeaderAction {
  icon: ReactNode;
  title: string;
  run: () => void;
}

export interface WinDef {
  id: WinId;
  title: string;
  fit: boolean;
  Body: ComponentType;
  /** The buttons of the header, left of «⋯». */
  actions: () => HeaderAction[];
}

function limitsRefresh(): void {
  const { subs } = useStore.getState();
  const id = subs?.defaultId ?? subs?.lastChoiceId ?? subs?.subscriptions.find(s => !s.retired)?.id;
  if (id) void refreshLimits(id);
}

export const WINDOWS: Record<WinId, WinDef> = {
  sessions: {
    id: 'sessions',
    get title() {
      return WIN_TITLE.sessions;
    },
    fit: false,
    Body: SessionsWindow,
    actions: () => [
      { icon: IconPlus, title: t('workspace.toolwindows.newSession'), run: () => useStore.setState({ modal: { type: 'new' } }) },
      { icon: IconSearch, title: t('workspace.toolwindows.search'), run: () => useStore.setState({ modal: { type: 'search' } }) },
    ],
  },
  files: {
    id: 'files',
    get title() {
      return WIN_TITLE.files;
    },
    fit: false,
    Body: FilesWindow,
    actions: () => [],
  },
  machines: {
    id: 'machines',
    get title() {
      return WIN_TITLE.machines;
    },
    fit: true,
    Body: MachinesWindow,
    actions: () => [],
  },
  subs: {
    id: 'subs',
    get title() {
      return WIN_TITLE.subs;
    },
    fit: true,
    Body: SubscriptionsWindow,
    actions: () => [{ icon: IconRefresh, title: t('workspace.toolwindows.refreshLimits'), run: limitsRefresh }],
  },
};
