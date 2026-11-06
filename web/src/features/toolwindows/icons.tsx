/**
 * Icons of the tool windows, ported one to one from docs/prototypes/tool-windows.html (IC, MI, chevSvg, dotsSvg, searchSvg).
 */
import type { ReactNode } from 'react';
import type { WinId } from './dock';

const RAIL: Record<WinId, ReactNode> = {
  sessions: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v8a1.5 1.5 0 0 1-1.5 1.5H8l-4 3v-3h.5A1.5 1.5 0 0 1 3 12.5z"
      />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 7.5h6M7 10.5h4" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d="M2.5 5A1.5 1.5 0 0 1 4 3.5h3.6l1.8 2h6.6A1.5 1.5 0 0 1 17.5 7v7.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"
      />
    </svg>
  ),
  machines: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 17h6M10 13.5V17" />
    </svg>
  ),
  subs: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3.5 14a6.5 6.5 0 1 1 13 0" />
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="m10 14 3.2-4" />
      <circle cx="10" cy="14" r="1.3" fill="currentColor" />
    </svg>
  ),
};

export const railIcon = (id: WinId): ReactNode => RAIL[id];

export const IconPlus = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M8 3v10M3 8h10" />
  </svg>
);

export const IconCollapse = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.4" d="M2.5 3.5h11v9h-11zM6 3.5v9" />
  </svg>
);

export const IconRefresh = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.4" d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />
  </svg>
);

export const IconSearch = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path stroke="currentColor" strokeWidth="1.4" d="m10.5 10.5 3 3" />
  </svg>
);

export const IconDots = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
    <circle cx="8" cy="8" r="1.3" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
  </svg>
);

export const IconChev = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.6" d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);

export const IconMenu = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
  </svg>
);

export const IconBack = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M11.5 4.5 6 10l5.5 5.5M6.5 10H16" />
  </svg>
);

export type MachineMenuIcon = 'new' | 'files' | 'mcp' | 'sess' | 'cfg';

const MI: Record<MachineMenuIcon, ReactNode> = {
  new: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6.5L3.5 13.5V11h0a1 1 0 0 1-1-1z" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M8 4.8v3.9M6.05 6.75h3.9" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.5h6a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />
    </svg>
  ),
  sess: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <circle cx="2.6" cy="4" r="1" fill="currentColor" />
      <circle cx="2.6" cy="8" r="1" fill="currentColor" />
      <circle cx="2.6" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  cfg: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        d="M6.9 1.8h2.2l.4 1.7 1.2.7 1.7-.5 1.1 1.9-1.3 1.2v1.4l1.3 1.2-1.1 1.9-1.7-.5-1.2.7-.4 1.7H6.9l-.4-1.7-1.2-.7-1.7.5-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.7.5 1.2-.7z"
      />
    </svg>
  ),
};

export const menuIcon = (id: MachineMenuIcon): ReactNode => MI[id];
