// The user's project catalogue in the instructions of a session (change catalog-db-session-context, D3): the hub sends
// it in session.start/resume (protocol 1.15), the agent renders it into Claude's system prompt and Codex's developer
// instructions. Requirement (session-project-context): Каталог проектов в контексте сессии.
import type { ProjectCatalogEntry } from '@agent-hub/shared';

export const PROJECT_CATALOG_HEADER =
  "The user's project catalog from Agent Hub (name, description, git remote, folder on this machine). Use it to tell which project the user means and where its code is.";
export const PROJECT_DESCRIPTION_MAX = 300;
export const PROJECT_CATALOG_TEXT_MAX = 16_000;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

function line(p: ProjectCatalogEntry): string {
  let text = `- ${oneLine(p.name)}${p.current ? ' (current session project)' : ''}`;
  const details: string[] = [];
  const description = p.description ? oneLine(p.description) : '';
  if (description) details.push(description.length > PROJECT_DESCRIPTION_MAX ? `${description.slice(0, PROJECT_DESCRIPTION_MAX - 1)}…` : description);
  if (p.remote) details.push(`remote ${oneLine(p.remote)}`);
  if (p.path) details.push(`folder ${oneLine(p.path)}`);
  if (details.length) text += `: ${details.join('; ')}`;
  return text;
}

/** The catalogue as instructions text; empty for an empty list. The current project goes first; lines stop at the text limit. */
export function renderProjectCatalog(list: readonly ProjectCatalogEntry[] | undefined): string {
  if (!list?.length) return '';
  const ordered = [...list.filter(p => p.current), ...list.filter(p => !p.current)];
  let text = PROJECT_CATALOG_HEADER;
  for (const p of ordered) {
    const next = `${text}\n${line(p)}`;
    if (next.length > PROJECT_CATALOG_TEXT_MAX) break;
    text = next;
  }
  return text === PROJECT_CATALOG_HEADER ? '' : text;
}
