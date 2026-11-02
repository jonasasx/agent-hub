// Paths the hub may send to an agent (fs.stat, session cwd). Only absolute local paths: a UNC or device path
// (\\host\share, //host/share, \\?\UNC\..., \\.\pipe) makes Windows authenticate to that host and leaks the
// user's NTLM hash; relative paths depend on the agent's working directory.
// Requirement: Запуск сессии из UI (каталог на машине).

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_BAD_CHARS = /[\u0000-\u001f<>"|?*]/;

/** C:\dir or C:/dir — a drive letter, no UNC/device prefix, no reserved device names. */
export function isLocalWindowsPath(p: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (WIN_BAD_CHARS.test(p.slice(2))) return false;
  const segments = p
    .slice(3)
    .split(/[\\/]+/)
    .filter(Boolean);
  return !segments.some(s => WIN_RESERVED.test(s.replace(/[ .]+$/, '')));
}

/** /dir — but not //host (POSIX leaves "//" implementation-defined; on Windows it is UNC). */
export function isLocalPosixPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('\u0000') && !p.includes('\\');
}

/** Accepted by the hub for any runner; the agent then checks its own platform. */
export function isAbsoluteLocalPath(p: string): boolean {
  return p.length > 0 && p.length <= 4096 && (isLocalWindowsPath(p) || isLocalPosixPath(p));
}

export const LOCAL_PATH_MESSAGE = 'нужен абсолютный локальный путь (C:\\… или /…), сетевые пути не допускаются';

// ---------- path vs the runner's OS (M2.1, D10 «Пути по ОС раннера») ----------

export type RunnerPlatform = 'windows' | 'linux';

/** The runner's platform from `runners.home_dir` (hello.homeDir): a drive letter → windows, `/…` → linux. */
export function platformOfHome(homeDir: string | null | undefined): RunnerPlatform | null {
  if (!homeDir) return null;
  if (/^[A-Za-z]:/.test(homeDir)) return 'windows';
  if (homeDir.startsWith('/')) return 'linux';
  return null;
}

/** An absolute local path of this platform; with an unknown platform — of either. */
export function pathFitsPlatform(path: string, platform: RunnerPlatform | null): boolean {
  if (path.length === 0 || path.length > 4096) return false;
  if (platform === 'windows') return isLocalWindowsPath(path);
  if (platform === 'linux') return isLocalPosixPath(path);
  return isAbsoluteLocalPath(path);
}

/** Russian text of 422 bad_path, shown at the directory field. */
export function badPathMessage(platform: RunnerPlatform | null): string {
  if (platform === 'windows') return 'Путь не подходит для Windows: нужен вид C:\\…';
  if (platform === 'linux') return 'Путь не подходит для Linux: нужен вид /…';
  return 'Путь не подходит: нужен полный локальный путь — C:\\… или /…';
}

/**
 * A git remote URL without `user[:password]@` (D9 p. 7): `https://oauth2:<token>@host/g/r.git` → `https://host/g/r.git`.
 * Everything up to the last `@` before the first `/` after the scheme goes (an `@` inside the password included).
 * The scp form `git@host:g/r` keeps its user (no secret). The agent strips before repl.meta, the hub when it stores.
 */
export function stripRemoteUserinfo(url: string): string;
export function stripRemoteUserinfo(url: string | null | undefined): string | null;
export function stripRemoteUserinfo(url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/, '$1');
}
