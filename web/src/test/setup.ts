import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { initLocale } from '../i18n';

// change i18n D10: the existing tests check Russian texts
await initLocale('ru');

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.dataset.theme = 'dark';
});
