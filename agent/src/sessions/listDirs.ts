import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isLocalPosixPath, isLocalWindowsPath } from '@agent-hub/shared';

export type DirectoryErrorCode = 'invalid_path' | 'not_found' | 'not_directory' | 'permission_denied' | 'too_many_entries';
export class DirectoryListingError extends Error {
  constructor(readonly code: DirectoryErrorCode) {
    super(code);
  }
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

export async function listDirectories(requestedPath: string | undefined, showHidden: boolean, home = homedir()): Promise<DirectoryListing> {
  const trimmed = requestedPath?.trim();
  if (trimmed && !(process.platform === 'win32' ? isLocalWindowsPath(trimmed) : isLocalPosixPath(trimmed))) throw new DirectoryListingError('invalid_path');
  let canonical: string;
  try {
    canonical = await realpath(trimmed || home);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DirectoryListingError(code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : code === 'ENOENT' ? 'not_found' : 'invalid_path');
  }
  let info;
  try {
    info = await stat(canonical);
  } catch {
    throw new DirectoryListingError('not_found');
  }
  if (!info.isDirectory()) throw new DirectoryListingError('not_directory');
  let entries;
  try {
    entries = await readdir(canonical, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DirectoryListingError(code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'invalid_path');
  }
  const directories = entries.filter(entry => entry.isDirectory() && (showHidden || !entry.name.startsWith('.')));
  if (directories.length > 500) throw new DirectoryListingError('too_many_entries');
  return {
    path: canonical,
    parent: path.dirname(canonical) === canonical ? null : path.dirname(canonical),
    directories: directories.map(entry => ({ name: entry.name, path: path.join(canonical, entry.name) })),
  };
}
