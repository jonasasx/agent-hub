/**
 * Projects of the vault on the client (design.md D9, D10): the directory for «Перенести в…», the evidence line under
 * the chat head and the local move of a session between projects of the tree when the hub reclassifies it.
 * Requirements (project-grouping): Справочник проектов; Ручной перенос и закрепление.
 * Requirements (workspace-ui): Дерево «Проекты»; Строка проекта под шапкой чата.
 */
import type { ProjectListItem, ProjectRef, SessionView, SidebarProject } from '../../api/types';
import { hubText, t, tText } from '../../i18n';

/** Kinds of the directory (shared `ProjectKind` and «Без проекта»). */
export type ProjectKind = ProjectListItem['kind'];

/** An element of `GET /api/projects` (D10); «Без проекта» has `id: 'none'`. */
export type ProjectItem = ProjectListItem;

/** The project of a session (`kind` and `archived` absent for «Без проекта» and on an older hub). */
export type ProjectInfo = ProjectRef;

export const noProject = (): ProjectItem => ({ id: 'none', kind: 'none', title: t('projects.none'), path: '', areaPath: null, colorKey: 'none', archived: false });

/** `GET /api/projects` → items; «Без проекта» is added when the hub did not list it. */
export function projectItems(body: unknown): ProjectItem[] {
  const list = (Array.isArray(body) ? body : ((body as { projects?: unknown[] } | null)?.projects ?? [])) as Partial<ProjectItem>[];
  const items = list.flatMap((p): ProjectItem[] =>
    p && typeof p.id === 'string' && typeof p.title === 'string'
      ? [{ id: p.id, kind: p.kind ?? 'project', title: hubText(p.title, p.i18n), path: p.path ?? '', areaPath: p.areaPath ?? null, colorKey: p.colorKey ?? 'none', archived: !!p.archived }]
      : [],
  );
  return items.some(p => p.id === 'none') ? items : [...items, noProject()];
}

/**
 * «Перенести в…»: by title or path, case-insensitive, in the order of the hub (D10: by area — the area, its systems,
 * projects and clones; then «Vault», «Знания»; «Без проекта» last).
 */
export function filterProjects(items: ProjectItem[], q: string): ProjectItem[] {
  const needle = q.trim().toLowerCase();
  return items.filter(p => !needle || p.title.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle));
}

export function kindLabel(kind: ProjectKind): string {
  return kind === 'builtin' || kind === 'none' ? '' : t(`projects.kind.${kind}`);
}

/** The evidence line under the chat head (spec «Строка проекта под шапкой чата»). */
export function evidenceText(s: SessionView): string {
  switch (s.projectSource) {
    // a deleted project: the key of the hub (`projectEvidenceI18n`), or the stored text — English now, Russian before
    case 'manual':
      return s.projectEvidenceI18n?.key === 'hub.projects.evidenceDeleted' || /^(проект удалён|project removed)/.test(s.projectEvidence ?? '')
        ? tText('hub.projects.evidenceDeleted')
        : t('projects.evidence.manual');
    case 'inherited':
      return t('projects.evidence.inherited');
    case 'auto':
      return s.projectEvidence ? t('projects.evidence.auto', { evidence: s.projectEvidence }) : t('projects.evidence.autoShort');
    default:
      return t('projects.evidence.unknown');
  }
}

/** The second project shown as a label after the evidence (D9 p. 6); absent before M4. */
export function secondaryProject(s: SessionView): ProjectInfo | null {
  return s.secondaryProject ?? null;
}

const LIVE = new Set(['working', 'waiting', 'permission', 'sleeping']);
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/** Projects by last activity, «Без проекта» always last (the hub sorts too; the client keeps it after local moves). */
export function sortProjects(list: SidebarProject[]): SidebarProject[] {
  return [...list].sort((a, b) => Number(a.project.id === null) - Number(b.project.id === null) || time(b.lastActivityAt) - time(a.lastActivityAt));
}

/**
 * The hub moved a session to another project (classification, a move, unpinning): move its row in the tree right away,
 * counters included, instead of waiting for the next `GET /api/sidebar` — no jump of the list when that arrives.
 */
export function regroup(
  projects: SidebarProject[],
  more: Record<string, SessionView[]>,
  prev: SessionView,
  next: SessionView,
  preview = 5,
): { projects: SidebarProject[]; more: Record<string, SessionView[]> } {
  const from = prev.project.id;
  const to = next.project.id;
  if (from === to) return { projects, more };
  const live = LIVE.has(next.status) ? 1 : 0;
  const wasLive = LIVE.has(prev.status) ? 1 : 0;
  let out = projects.map(p => (p.project.id === from ? { ...p, total: p.total - 1, live: Math.max(0, p.live - wasLive), sessions: p.sessions.filter(x => x.id !== next.id) } : p));
  const target = out.find(p => p.project.id === to);
  const at = next.lastEventAt ?? next.createdAt;
  if (target) {
    const sessions = [next, ...target.sessions.filter(x => x.id !== next.id)].sort((a, b) => time(b.lastEventAt ?? b.createdAt) - time(a.lastEventAt ?? a.createdAt)).slice(0, preview);
    out = out.map(p =>
      p === target ? { ...p, project: next.project, total: p.total + 1, live: p.live + live, lastActivityAt: time(at) > time(p.lastActivityAt) ? at : p.lastActivityAt, sessions } : p,
    );
  } else {
    out.push({ project: next.project, total: 1, live, lastActivityAt: at, sessions: [next] });
  }
  out = out.filter(p => p.total > 0);
  const m = { ...more };
  const fromKey = from ?? 'none';
  const toKey = to ?? 'none';
  if (m[fromKey]) m[fromKey] = m[fromKey].filter(x => x.id !== next.id);
  if (m[toKey]) m[toKey] = [next, ...m[toKey].filter(x => x.id !== next.id)];
  return { projects: sortProjects(out), more: m };
}
