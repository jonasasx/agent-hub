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

/** Icons of the profile menu, the settings navigation and Ctrl K commands (change profile-menu-grouping). */
export type ProfileIcon = 'shield' | 'gear' | 'eyeoff' | 'reset' | 'logout' | 'users' | 'usage' | 'bell' | 'globe' | 'clock' | 'download' | 'theme' | 'sleep';

const PI: Record<ProfileIcon, ReactNode> = {
  shield: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M8 1.8 13 3.6v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4z" />
    </svg>
  ),
  gear: MI.cfg,
  eyeoff: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="m2.5 13.5 11-11" />
    </svg>
  ),
  reset: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 5l3 3-3 3M13 8H6" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M1.8 13.5a4.2 4.2 0 0 1 8.4 0M10.5 3.4a2.3 2.3 0 0 1 0 4.3M12 9.6a4.2 4.2 0 0 1 2.2 3.9" />
    </svg>
  ),
  usage: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3 13.5V9M6.3 13.5V5.5M9.7 13.5V7.5M13 13.5V3" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8z" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M6.6 14.2h2.8" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" d="M2 8h12M8 2c-2.2 2.4-2.2 9.6 0 12M8 2c2.2 2.4 2.2 9.6 0 12" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M8 4.5V8l2.3 1.5" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M2.5 13.5h11" />
    </svg>
  ),
  theme: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path fill="currentColor" d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" />
    </svg>
  ),
  sleep: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M12.8 9.6A5.5 5.5 0 0 1 6.4 3.2a5.5 5.5 0 1 0 6.4 6.4z" />
    </svg>
  ),
};

export const profileIcon = (id: ProfileIcon): ReactNode => PI[id];
