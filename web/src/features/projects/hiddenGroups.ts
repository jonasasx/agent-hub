/**
 * The count of hidden project groups and the dialog «Скрытые группы» (change profile-menu-grouping, spec
 * projects-catalog): read on load and after hiding, undoing and restoring a group — not on every sidebar refresh.
 */
import { api } from '../../api/client';
import { useStore } from '../../store';

export async function loadHiddenGroups(): Promise<void> {
  try {
    const groups = await api.hiddenProjectGroups();
    useStore.setState({ hiddenGroups: groups.length });
  } catch (failure) {
    console.warn('Не удалось загрузить скрытые группы', failure);
  }
}

export function openHiddenProjects(): void {
  useStore.setState({ hiddenProjectsOpen: true });
}

export function closeHiddenProjects(): void {
  useStore.setState({ hiddenProjectsOpen: false });
}
