// Requirement: Темы — dark by default; the choice is stored per device.
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'ah-theme';

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode: the theme still applies for this page
  }
  for (const listener of listeners) listener();
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme for the switches: the rail, the phone top bar and Ctrl K «>» change it in one place. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}

export function toggleTheme(): void {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
