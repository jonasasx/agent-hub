// Content-Security-Policy of the hub's web app (design D19).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_THEME_SCRIPT } from './pages.js';

/** sha256 sources of the inline <script> blocks of index.html (the theme script runs before first paint). */
export function inlineScriptHashes(webDistDir: string): string[] {
  const file = join(webDistDir, 'index.html');
  if (!existsSync(file)) return [];
  const html = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1]!.trim()) out.push(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
  }
  return out;
}

/**
 * voice-conversation D8: the conversation's WebSocket goes to the ElevenLabs API host, so the policy lets the page
 * connect there (https and wss) when the conversation is on.
 */
export function voiceConnectSources(apiUrl: string): string[] {
  const origin = new URL(apiUrl).origin;
  return [origin, origin.replace(/^http/, 'ws')];
}

/** The theme script of the hub's own pages (`pages.ts`), let in by its hash on every HTML response. */
export const PAGE_THEME_HASH = `'sha256-${createHash('sha256').update(PAGE_THEME_SCRIPT, 'utf8').digest('base64')}'`;

export function contentSecurityPolicy(publicOrigins: string[], scriptHashes: string[], extraConnect: string[] = []): string {
  const ws = publicOrigins.map(o => o.replace(/^http/, 'ws')).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${[ws, ...extraConnect].join(' ')}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The policy for HTML responses. The hashes follow index.html: a new web build (a deploy that replaces web/dist
 * without restarting the hub) changes the theme script, so they are recomputed when the file's mtime or size moves.
 */
export function cspProvider(publicOrigins: string[], webDistDir: string, extraConnect: string[] = []): () => string {
  const file = join(webDistDir, 'index.html');
  let key = '';
  let value = contentSecurityPolicy(publicOrigins, [PAGE_THEME_HASH], extraConnect);
  return () => {
    let k = 'none';
    try {
      const st = statSync(file);
      k = `${st.mtimeMs}:${st.size}`;
    } catch {
      // no web build: no inline scripts
    }
    if (k !== key) {
      key = k;
      value = contentSecurityPolicy(publicOrigins, [PAGE_THEME_HASH, ...inlineScriptHashes(webDistDir)], extraConnect);
    }
    return value;
  };
}
