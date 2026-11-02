import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startUpdates } from './features/update/check';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// change client-versions D3: the SW and the build checks start after the first render, never blocking it
setTimeout(() => startUpdates(), 0);
