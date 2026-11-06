import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startUpdates } from './features/update/check';
import { applyStoredWidths } from './features/toolwindows/useDock';
import { openToolWindow } from './features/toolwindows/open';
import { setOpenFilesWindow } from './features/files/toolWindowBridge';
import './styles/tokens.css';
import './styles/app.css';
import './styles/files.css';

applyStoredWidths();
// the explorer shows its window through the dock: a hidden one comes back, an inactive slot tab is activated, the phone opens it over the home screen
setOpenFilesWindow(() => openToolWindow('files'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// change client-versions D3: the SW and the build checks start after the first render, never blocking it
setTimeout(() => startUpdates(), 0);
