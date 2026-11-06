// The project of a session from its path signals (design D9 p. 6, task 4.5). Weights: edit 3, read 1, cwd/remote 3;
// reads of «Vault» weigh nothing, and reads of a cron session weigh nothing (a scheduled job reads its inputs
// wherever they lie; it belongs where it writes or starts — M4a prod sample). The weight of an area (signals inside it but outside its elements) goes to the
// leader of the same area and is no rival. The leader (heaviest non-area element) becomes the project when its own
// weight is ≥3 and (its share with the area weight ≥50% or it is ≥2× the second); a single element with signals at any
// weight; otherwise an area with ≥3 and ≥50%; otherwise none. Once decided, the project changes only when the new
// leader is ≥2× the current one, and stays without a leader while it has weight. Requirement (project-grouping): Классификация по путям.

export interface ItemInfo {
  id: string;
  kind: 'area' | 'system' | 'project' | 'repo' | 'builtin';
  areaPath: string | null;
  path: string;
  title: string;
  /** «Vault»: reads give no weight. */
  readsFree?: boolean;
}

export interface Touch {
  op: 'edit' | 'read' | 'cwd' | 'remote';
  projectId: string | null;
  /** remote: the normalised remote for the evidence text. */
  pathNorm?: string;
}

export interface Evidence {
  edits: number;
  reads: number;
  cwd: number;
  remote: string | null;
  text: string;
}

export interface Decision {
  projectId: string | null;
  secondaryId: string | null;
  evidence: Evidence | null;
}

const W = { edit: 3, read: 1, cwd: 3, remote: 3 } as const;

/** The evidence line stored with an automatic decision; English (the stored text is not translated, a manual or inherited one has a key). */
export const DELETED_EVIDENCE = 'project removed from the catalog';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function evidenceText(e: Omit<Evidence, 'text'>, title: string): string {
  const parts: string[] = [];
  if (e.edits) parts.push(plural(e.edits, 'edit', 'edits'));
  if (e.reads) parts.push(plural(e.reads, 'read', 'reads'));
  const inX = parts.length ? `${parts.join(' and ')} in ${title}` : '';
  const extra: string[] = [];
  if (e.cwd) extra.push(`launch folder in ${title}`);
  if (e.remote) extra.push(`git remote ${e.remote.split('/').slice(1).join('/')}`);
  return [inX, ...extra].filter(Boolean).join(', ');
}

interface Score {
  item: ItemInfo;
  weight: number;
  edits: number;
  reads: number;
  cwd: number;
  remote: string | null;
}

export interface ClassifyOptions {
  /** A cron session: reads give no weight. */
  cron?: boolean;
}

export function scores(touches: Touch[], items: Map<string, ItemInfo>, opts: ClassifyOptions = {}): Map<string, Score> {
  const out = new Map<string, Score>();
  for (const t of touches) {
    if (!t.projectId) continue;
    const item = items.get(t.projectId);
    if (!item) continue;
    const w = t.op === 'read' && (item.readsFree || opts.cron) ? 0 : W[t.op];
    if (!w) continue;
    let s = out.get(item.id);
    if (!s) out.set(item.id, (s = { item, weight: 0, edits: 0, reads: 0, cwd: 0, remote: null }));
    s.weight += w;
    if (t.op === 'edit') s.edits++;
    else if (t.op === 'read') s.reads++;
    else if (t.op === 'cwd') s.cwd++;
    else s.remote = t.pathNorm?.replace(/^remote:/, '') ?? s.remote;
  }
  return out;
}

const ev = (s: Score): Evidence => {
  const e = { edits: s.edits, reads: s.reads, cwd: s.cwd, remote: s.remote };
  return { ...e, text: evidenceText(e, s.item.title) };
};

/**
 * The decision for a session. `current` — the auto project decided before (hysteresis), the same for the live
 * recompute and projects:reclassify; null for a fresh decision (unpinning, a session without an auto project).
 */
export function classify(touches: Touch[], items: Map<string, ItemInfo>, current: string | null = null, opts: ClassifyOptions = {}): Decision {
  const sc = scores(touches, items, opts);
  const all = [...sc.values()];
  if (!all.length) return { projectId: null, secondaryId: null, evidence: null };
  const sum = all.reduce((a, s) => a + s.weight, 0);
  const areas = all.filter(s => s.item.kind === 'area');
  const others = all.filter(s => s.item.kind !== 'area').sort((a, b) => b.weight - a.weight);
  const areaWeight = (s: Score) => areas.find(a => s.item.areaPath && a.item.path === s.item.areaPath)?.weight ?? 0;

  let pick: Score | null = null;
  if (all.length === 1) pick = all[0]!;
  else {
    const leader = others[0];
    const second = others[1]?.weight ?? 0;
    // A tie for the first place is no leader (50% each would otherwise pick by sort order).
    if (leader && leader.weight > second && leader.weight >= 3 && ((leader.weight + areaWeight(leader)) / sum >= 0.5 || leader.weight >= 2 * second)) pick = leader;
    else {
      const area = [...areas].sort((a, b) => b.weight - a.weight)[0];
      if (area && area.weight >= 3 && area.weight / sum >= 0.5) pick = area;
    }
  }
  // Hysteresis: a decided project stays until the new leader is twice as heavy.
  if (current && pick && pick.item.id !== current) {
    const cur = sc.get(current);
    if (cur && pick.weight < 2 * cur.weight) pick = cur;
  }
  // Without a leader the decided project stays — while it still has weight under the current rules (a project
  // whose signals are gone or weigh nothing now, e.g. the reads of a cron session, is not kept by hysteresis).
  if (!pick && current) pick = sc.get(current) ?? null;
  if (!pick) return { projectId: null, secondaryId: null, evidence: null };
  const secondary = others.find(s => s.item.id !== pick!.item.id && s.weight >= 3) ?? null;
  return { projectId: pick.item.id, secondaryId: secondary?.item.id ?? null, evidence: ev(pick) };
}
