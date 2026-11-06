// Remote normalisation and the path matcher of the legacy catalogue (`projects`). The catalogue itself lives only in the
// database (change catalog-db-session-context): nothing here reads user files.

export type ItemKind = 'area' | 'system' | 'project' | 'repo' | 'builtin';

/**
 * A git remote as `host/group/repo`: no scheme, no `user[:password]@`, `host:path` → `host/path`, no `.git`, lower
 * case. Null for an empty value.
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^/]*@/, ''); // userinfo (git@, oauth2:token@, a password with @)
  s = s.replace(/^([^/:]+):(?!\d+\/)/, '$1/'); // scp form host:path (not host:port/)
  s = s.replace(/^([^/:]+):\d+\//, '$1/'); // port
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  return s.toLowerCase();
}

/** `user[:password]@` removed from a remote URL (shared with the agent, D9 p. 7). */
export { stripRemoteUserinfo as stripUserinfo } from '@agent-hub/shared';

/** A matcher over vault-relative paths: the element of the longest matching prefix (case-insensitive). */
export class PathMatcher {
  private readonly prefixes: Array<{ prefix: string; id: string }> = [];
  constructor(items: Array<{ id: string; prefixes: string[] }>) {
    for (const item of items) for (const p of item.prefixes) this.prefixes.push({ prefix: p.toLowerCase(), id: item.id });
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  match(rel: string): string | null {
    const r = rel.toLowerCase();
    for (const { prefix, id } of this.prefixes) if (r === prefix || r.startsWith(`${prefix}/`)) return id;
    return null;
  }
}
