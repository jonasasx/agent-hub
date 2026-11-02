/**
 * Build description: `/version.json` served by the hub and the client's own build embedded at build time
 * (change `client-versions`, design D1, task 1.2). Web-only: the hub serves the file from `dist` and never reads it.
 *
 * Format: `{ "version": "0.1.0", "commit": "72d9dc7", "builtAt": "2026-10-28T04:17:07Z" }`
 * - `version` — `version` of `web/package.json`;
 * - `commit` — short git commit, or `dev` for a build without a number;
 * - `builtAt` — build time, ISO 8601 UTC.
 */
export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
}

/** Commit of a build without a number (local development). */
export const DEV_COMMIT = 'dev';

/** Shape check of a `/version.json` response; anything else counts as a failed request. */
export function isBuildInfo(v: unknown): v is BuildInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === 'string' &&
    o.version.length > 0 &&
    typeof o.commit === 'string' &&
    (o.commit === DEV_COMMIT || /^[0-9a-f]{7,40}$/.test(o.commit)) &&
    typeof o.builtAt === 'string' &&
    !Number.isNaN(Date.parse(o.builtAt))
  );
}

/** Same build: equal commits; two `dev` builds are compared by build time. */
export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  if (a.commit === DEV_COMMIT && b.commit === DEV_COMMIT) return a.builtAt === b.builtAt;
  return a.commit === b.commit;
}

/** One string per build (storage keys, «Позже», the loop guard): the commit, or `dev@<builtAt>`. */
export function buildKey(b: BuildInfo): string {
  return b.commit === DEV_COMMIT ? `${DEV_COMMIT}@${b.builtAt}` : b.commit;
}

/** «0.1.0 · 72d9dc7 · 28.10 07:17» — version · commit · build time in the browser's time zone (design D6). */
export function formatBuild(b: BuildInfo): string {
  const d = new Date(b.builtAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${b.version} · ${b.commit} · ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
