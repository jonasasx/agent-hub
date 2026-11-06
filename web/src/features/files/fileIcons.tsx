/**
 * Icons and kinds of files in the tree and on tabs (change tool-windows-file-explorer, design D6). The SVG is the set of
 * docs/prototypes/file-explorer.html (`SVG`), the colour classes `k-*` are the prototype's too (fx-ic in files.css).
 * Requirement (file-explorer): Ленивое дерево — «иконки типов (папка, изображение, PDF, Markdown, код/текст, прочий файл)».
 */
import type { FsEntry } from '@agent-hub/shared';

/** The class of a name by its extension: it picks the icon and the first guess of the viewer (the hub's X-File-Kind decides). */
export type NameKind = 'dir' | 'md' | 'img' | 'pdf' | 'txt' | 'bin';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const BINARY_EXT = new Set([
  'exe',
  'zip',
  'msi',
  'db',
  'sqlite',
  'gz',
  'tgz',
  'tar',
  '7z',
  'rar',
  'dll',
  'so',
  'dylib',
  'bin',
  'class',
  'jar',
  'iso',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'wav',
  'ico',
  'bmp',
  'tiff',
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function nameKind(name: string): NameKind {
  const ext = extOf(name);
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (IMAGE_EXT.has(ext)) return 'img';
  if (ext === 'pdf') return 'pdf';
  if (BINARY_EXT.has(ext)) return 'bin';
  return 'txt';
}

export function entryKind(e: Pick<FsEntry, 'name' | 'kind'>): NameKind {
  if (e.kind === 'dir') return 'dir';
  if (e.kind === 'other') return 'bin';
  return nameKind(e.name);
}

export const ICON_DIR = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M1.5 4a1 1 0 0 1 1-1h3.7l1.5 1.6h5.8a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);

export const ICON_DIR_OPEN = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M1.5 4a1 1 0 0 1 1-1h3.7l1.5 1.6h5.3a1 1 0 0 1 1 1v.9H4.3a1 1 0 0 0-.95.68L1.5 12z" />
    <path fill="currentColor" opacity=".75" d="M3.6 7.6a.8.8 0 0 1 .76-.55h10.4a.6.6 0 0 1 .57.8l-1.6 4.6a.8.8 0 0 1-.76.55H2.1z" />
  </svg>
);

export const ICON_IMG = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5.3" cy="6" r="1.3" fill="currentColor" />
    <path fill="currentColor" d="M2.5 12.5 6.5 8.5l2.3 2.2 2-1.9 2.7 3.7z" />
  </svg>
);

export function iconFile(label: string) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.2" d="M3.5 1.5h6l3 3v10h-9z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.2" d="M9.5 1.5v3h3" />
      {label ? (
        <>
          <rect x="2" y="8.2" width="9.6" height="5" rx="1.2" fill="currentColor" />
          <text x="6.8" y="12.1" textAnchor="middle" fontSize="4.3" fontWeight="700" fontFamily="Segoe UI,sans-serif" fill="var(--surface)">
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}

export const ICON_LOCK = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </svg>
);

export const ICON_CHEV = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.6" d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);

export const ICON_FOLDER_BTN = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M1.8 4.2a.9.9 0 0 1 .9-.9h3.4l1.4 1.5h5.8a.9.9 0 0 1 .9.9v6.6a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9z" />
  </svg>
);

export const ICON_UP = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M8 13V3M4 7l4-4 4 4" />
  </svg>
);

export const ICON_BACK = (
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.6" d="M10 3 5 8l5 5" />
  </svg>
);

export const ICON_COPY = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M3 10.5V3.8A1.3 1.3 0 0 1 4.3 2.5H10" />
  </svg>
);

export const ICON_REFRESH = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.4" d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  </svg>
);

interface FileIconProps {
  kind: NameKind;
  open?: boolean;
  blocked?: boolean;
}

/** The icon of a tree row or a tab: a folder (open or closed), an image, PDF, Markdown, code/text or another file. */
export function FileIcon({ kind, open, blocked }: FileIconProps) {
  if (blocked) return <span className="fx-ic k-bin">{ICON_LOCK}</span>;
  if (kind === 'dir') return <span className="fx-ic k-dir">{open ? ICON_DIR_OPEN : ICON_DIR}</span>;
  if (kind === 'img') return <span className="fx-ic k-img">{ICON_IMG}</span>;
  const label = kind === 'md' ? 'MD' : kind === 'pdf' ? 'PDF' : '';
  return <span className={`fx-ic k-${kind}`}>{iconFile(label)}</span>;
}
