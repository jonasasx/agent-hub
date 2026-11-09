import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { sql } from 'kysely';
import { allocateProjectColor, platformOfHome, projectDir, type ProjectSuggestionAnswer } from '@agent-hub/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { normalizeRemote } from './catalog.js';
import { classificationSchema, redactClassifierText, type ProjectClassifier } from './haiku.js';
import { toolPaths } from './signals.js';
import { HttpError } from '../sessions/service.js';
import type { ProjectService } from './service.js';

const RULE_REASONS = new Set(['cwd', 'remote', 'changed_files']);

export interface DetectionCandidate {
  id: string;
  remote: string | null;
  paths: string[];
}
function canonical(raw: string): string {
  const windows = /^[a-z]:[\\/]/i.test(raw);
  const p = windows ? path.win32.normalize(raw).replaceAll('\\', '/').toLowerCase() : path.posix.normalize(raw);
  return p.replace(/\/$/, '');
}
export function deterministicProject(candidates: DetectionCandidate[], cwd: string | null, remote: string | null, edits: string[]): { id: string; reason: string } | null {
  const unique = (matches: DetectionCandidate[], reason: string) => (matches.length === 1 ? { id: matches[0]!.id, reason } : null);
  const exact = candidates.filter(c => c.paths.some(p => cwd !== null && canonical(p) === canonical(cwd)));
  if (exact.length) return unique(exact, 'cwd');
  const normalized = normalizeRemote(remote);
  const remotes = normalized ? candidates.filter(c => normalizeRemote(c.remote) === normalized) : [];
  if (remotes.length) return unique(remotes, 'remote');
  const changed = candidates.filter(c => c.paths.some(p => edits.some(e => canonical(e).startsWith(`${canonical(p)}/`))));
  return unique(changed, 'changed_files');
}

export class CatalogDetection {
  private readonly classifier: ProjectClassifier | undefined;
  constructor(
    private readonly o: {
      db: Db;
      config: Config;
      projects: ProjectService;
      classifier?: ProjectClassifier;
      changed: (id: string) => Promise<unknown>;
      log: { info: (data: object, message: string) => void };
    },
  ) {
    this.classifier = o.classifier;
  }

  /** `rulesOnly`: catalog edits re-run the path/remote rules for unassigned sessions, never the model. */
  evaluate(id: string, firstMessage?: string, rulesOnly = false): Promise<void> {
    return this.o.projects.serialized(id, () => this.evaluateNow(id, firstMessage, rulesOnly));
  }

  private async evaluateNow(id: string, firstMessage?: string, rulesOnly = false): Promise<void> {
    const { db, config } = this.o;
    const s = await db
      .selectFrom('sessions')
      .select(['id', 'user_id', 'cwd', 'git_remote', 'runner_id', 'project_source', 'source', 'is_drive_import', 'spawned_by', 'first_event_at', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!s || s.project_source === 'manual') return;
    let link = await db.selectFrom('session_projects').select(['source', 'reason_code']).where('user_id', '=', s.user_id).where('session_id', '=', id).executeTakeFirst();
    if (link && link.source !== 'auto') return;
    const candidates = await db
      .selectFrom('catalog_projects')
      .select(['id', 'name', 'description', 'remote', 'folder', 'updated_at'])
      .where('user_id', '=', s.user_id)
      .where('archived', '=', false)
      .orderBy(sql`last_event_at DESC NULLS LAST`)
      .orderBy('id')
      .execute();
    if (!candidates.length) return;
    // session-folder D5: a project's path on the session's machine is its folder under the machine's default folder.
    const runner = await db.selectFrom('runners').select(['home_dir', 'default_dir']).where('id', '=', s.runner_id).executeTakeFirst();
    const base = runner?.default_dir ?? runner?.home_dir ?? null;
    const windows = platformOfHome(runner?.home_dir) === 'windows';
    // Read only main-transcript user lines and structured edit calls; never tool results/file contents.
    const messages = await db
      .selectFrom('events as e')
      .innerJoin('transcript_files as f', 'f.id', 'e.file_id')
      .select('e.payload')
      .where('e.session_id', '=', id)
      .where('f.user_id', '=', s.user_id)
      .where('f.kind', '=', 'main')
      .where('f.superseded_at', 'is', null)
      .where('e.is_sidechain', '=', false)
      .where('e.type', '=', 'user')
      .where(
        sql<boolean>`e.payload->>'isMeta' IS DISTINCT FROM 'true' AND (jsonb_typeof(e.payload->'message'->'content')='string' OR jsonb_path_exists(e.payload, '$.message.content[*] ? (@.type == "text")'))`,
      )
      .orderBy('e.ts')
      .orderBy('e.line_no')
      .limit(config.PROJECT_CLASSIFIER_MAX_MESSAGES)
      .execute();
    const editsResult = await sql<{
      payload: Record<string, unknown>;
    }>`SELECT e.payload FROM events e JOIN transcript_files f ON f.id=e.file_id WHERE e.session_id=${id} AND f.user_id=${s.user_id} AND f.kind='main' AND f.superseded_at IS NULL AND NOT e.is_sidechain AND e.type='assistant' AND jsonb_path_exists(e.payload, '$.message.content[*] ? (@.type == "tool_use" && (@.name == "Edit" || @.name == "Write" || @.name == "MultiEdit" || @.name == "NotebookEdit"))') ORDER BY e.ts,e.line_no LIMIT 200`.execute(
      db,
    );
    const edits = editsResult.rows
      .flatMap(r =>
        toolPaths(r.payload, /^[a-z]:/i.test(s.cwd ?? ''))
          .filter(t => t.op === 'edit')
          .map(t => {
            const platform = /^[a-z]:/i.test(s.cwd ?? '') ? path.win32 : path.posix;
            return platform.isAbsolute(t.path) ? t.path : s.cwd ? platform.resolve(s.cwd, t.path) : '';
          }),
      )
      .filter(Boolean);
    const match = deterministicProject(
      candidates.map(c => ({ ...c, paths: base && c.folder ? [projectDir(base, c.folder, windows)] : [] })),
      s.cwd,
      s.git_remote,
      edits,
    );
    if (match) {
      await db.transaction().execute(async tx => {
        const current = await tx.selectFrom('sessions').select('project_source').where('id', '=', id).forUpdate().executeTakeFirst();
        if (current?.project_source === 'manual') return;
        await tx
          .insertInto('session_projects')
          .values({ user_id: s.user_id, session_id: id, project_id: match.id, source: 'auto', confidence: 1, reason_code: match.reason })
          .onConflict(oc =>
            oc.columns(['user_id', 'session_id']).doUpdateSet({ project_id: match.id, source: 'auto', confidence: 1, reason_code: match.reason }).where('session_projects.source', '=', 'auto'),
          )
          .execute();
      });
      await this.o.changed(id);
      return;
    }
    // A rule link whose binding, remote or files no longer match is stale: drop it so the session can be classified again.
    if (link && RULE_REASONS.has(link.reason_code ?? '')) {
      await db
        .deleteFrom('session_projects')
        .where('user_id', '=', s.user_id)
        .where('session_id', '=', id)
        .where('source', '=', 'auto')
        .where('reason_code', 'in', [...RULE_REASONS])
        .execute();
      await this.o.changed(id);
      link = undefined;
    }
    if (link || rulesOnly || !config.PROJECT_CLASSIFIER_ENABLED || !this.classifier) return;
    // Cron, imported, spawned and old replicated sessions would spend the subscription and the daily budget on history.
    if (s.source === 'cron' || s.source === 'drive_import' || s.is_drive_import || s.spawned_by) return;
    const startedAt = s.first_event_at ?? s.created_at;
    if (Date.now() - startedAt.getTime() > config.PROJECT_CLASSIFIER_MAX_SESSION_AGE_HOURS * 3_600_000) return;
    const classifier = this.classifier;
    const texts = messages.flatMap(row => {
      const p = row.payload as { message?: { content?: unknown }; isMeta?: boolean };
      if (p.isMeta) return [];
      const content = p.message?.content;
      if (typeof content === 'string') return [content];
      if (!Array.isArray(content)) return [];
      return [
        content
          .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
          .map((b: { text: string }) => b.text)
          .join('\n'),
      ];
    });
    if (!texts.length && firstMessage) texts.push(firstMessage);
    const text = redactClassifierText(texts.slice(0, config.PROJECT_CLASSIFIER_MAX_MESSAGES).join('\n')).slice(0, config.PROJECT_CLASSIFIER_MAX_INPUT_CHARS);
    if (!text.trim()) return;
    const hash = createHash('sha256').update(text).digest('hex');
    const previous = await db.selectFrom('project_suggestions').selectAll().where('user_id', '=', s.user_id).where('session_id', '=', id).executeTakeFirst();
    if (previous?.state === 'accepted' || (previous?.messages_hash === hash && previous.state === 'dismissed')) return;
    // Only what the model sees: a colour change must not make pending cards stale.
    const version = JSON.stringify(candidates.map(c => [c.id, c.name, c.description, c.remote]));
    const inputHash = createHash('sha256')
      .update(hash + version)
      .digest('hex');
    if (previous?.input_hash === inputHash) return;
    const examples = await sql<{ project_id: string; payload: { message?: { content?: unknown } } }>`
      SELECT sp.project_id, e.payload FROM session_projects sp
      JOIN LATERAL (SELECT ev.payload FROM events ev JOIN transcript_files f ON f.id=ev.file_id
        WHERE ev.session_id=sp.session_id AND f.user_id=sp.user_id AND f.kind='main' AND f.superseded_at IS NULL
          AND ev.type='user' AND NOT ev.is_sidechain AND ev.payload->>'isMeta' IS DISTINCT FROM 'true'
        ORDER BY ev.ts,ev.line_no LIMIT 1) e ON true
      WHERE sp.user_id=${s.user_id} AND sp.source IN ('manual','explicit') ORDER BY sp.created_at DESC LIMIT 50`.execute(db);
    const input = JSON.stringify({
      messages: text,
      candidates: candidates.slice(0, config.PROJECT_CLASSIFIER_MAX_CANDIDATES).map(c => ({
        id: c.id,
        name: redactClassifierText(c.name),
        description: redactClassifierText(c.description),
        remote: redactClassifierText(normalizeRemote(c.remote) ?? ''),
        confirmedMessages: examples.rows
          .filter(e => e.project_id === c.id)
          .slice(0, 2)
          .flatMap(e => (typeof e.payload.message?.content === 'string' ? [redactClassifierText(e.payload.message.content).slice(0, 300)] : [])),
      })),
    });
    const started = Date.now();
    const allowed = await db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project_classifier:${s.user_id}`},0))`.execute(tx);
      const usage = await sql<{
        session: string;
        calls: string;
      }>`SELECT count(*) FILTER (WHERE session_id=${id}) session, count(*) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') calls FROM project_classifier_usage WHERE user_id=${s.user_id}`.execute(
        tx,
      );
      if (Number(usage.rows[0]!.session) >= config.PROJECT_CLASSIFIER_MAX_CALLS_PER_SESSION || Number(usage.rows[0]!.calls) >= config.PROJECT_CLASSIFIER_DAILY_LIMIT_PER_USER) return false;
      const row = await tx.insertInto('project_classifier_usage').values({ user_id: s.user_id, session_id: id }).returning('id').executeTakeFirstOrThrow();
      return row.id;
    });
    if (allowed === false) return;
    const signal = AbortSignal.timeout(config.PROJECT_CLASSIFIER_TIMEOUT_MS);
    let decision;
    try {
      decision = classificationSchema.parse(
        await Promise.race([
          classifier.classify(s.user_id, input, signal),
          new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('classifier_timeout')), { once: true })),
        ]),
      );
    } catch (error) {
      // No machine took the turn: the model never ran, so the attempt does not count against the limits.
      const offline = error instanceof HttpError && error.code === 'runner_offline';
      if (offline) await db.deleteFrom('project_classifier_usage').where('id', '=', allowed).execute();
      // The parse error text can quote the model answer; log only its kind.
      const reasonCode = signal.aborted ? 'timeout' : offline ? 'runner_offline' : 'provider_error';
      this.o.log.info({ reasonCode, error: error instanceof HttpError ? error.code : (error as Error).name, latencyMs: Date.now() - started }, 'project classifier skipped');
      return;
    }
    const known = new Set(candidates.slice(0, config.PROJECT_CLASSIFIER_MAX_CANDIDATES).map(c => c.id));
    const best = decision.projectId && known.has(decision.projectId) ? decision.projectId : null;
    const options = [...new Set([best, ...decision.alternatives].filter((o): o is string => !!o && known.has(o)))].slice(0, 3);
    const auto = best !== null && decision.confidence >= config.PROJECT_CLASSIFIER_AUTO_CONFIDENCE;
    const newName = decision.newProjectName?.normalize('NFC') || null;
    // Recheck the pin after the model call, under the same row lock used by accept/dismiss and manual moves.
    await db.transaction().execute(async tx => {
      const currentSession = await tx.selectFrom('sessions').select('project_source').where('user_id', '=', s.user_id).where('id', '=', id).forUpdate().executeTakeFirst();
      if (currentSession?.project_source === 'manual') return;
      if (await tx.selectFrom('session_projects').select('session_id').where('user_id', '=', s.user_id).where('session_id', '=', id).executeTakeFirst()) return;
      const old = await tx.selectFrom('project_suggestions').selectAll().where('user_id', '=', s.user_id).where('session_id', '=', id).executeTakeFirst();
      if (old?.state === 'accepted' || (old?.state === 'dismissed' && old.messages_hash === hash)) return;
      // The call takes up to 90 s: a project deleted or archived meanwhile must not reach the foreign keys.
      const rows = options.length
        ? await tx.selectFrom('catalog_projects').select('id').where('user_id', '=', s.user_id).where('archived', '=', false).where('id', 'in', options).forShare().execute()
        : [];
      const live = new Set(rows.map(r => r.id));
      const liveOptions = options.filter(o => live.has(o));
      if (auto && best && live.has(best)) {
        await tx.insertInto('session_projects').values({ user_id: s.user_id, session_id: id, project_id: best, source: 'auto', confidence: decision.confidence, reason_code: 'classifier' }).execute();
        await tx.deleteFrom('project_suggestions').where('user_id', '=', s.user_id).where('session_id', '=', id).execute();
        return;
      }
      const values = {
        project_id: liveOptions[0] ?? null,
        options: liveOptions,
        new_project_name: newName,
        confidence: decision.confidence,
        reason_code: decision.reasonCode,
        input_hash: inputHash,
        messages_hash: hash,
        state: 'pending' as const,
        updated_at: new Date(),
      };
      await tx
        .insertInto('project_suggestions')
        .values({ user_id: s.user_id, session_id: id, ...values })
        .onConflict(oc => oc.columns(['user_id', 'session_id']).doUpdateSet(values))
        .execute();
    });
    this.o.log.info({ latencyMs: Date.now() - started, reasonCode: decision.reasonCode, confidence: decision.confidence, auto }, 'project classifier decided');
    await this.o.changed(id);
  }

  async catalogChanged(userId: string): Promise<void> {
    const rows = await this.o.db
      .selectFrom('sessions as s')
      .select('s.id')
      .where('s.user_id', '=', userId)
      .where('s.project_source', '<>', 'manual')
      .where(sql<boolean>`NOT EXISTS(SELECT 1 FROM session_projects sp WHERE sp.user_id=s.user_id AND sp.session_id=s.id)`)
      .orderBy('s.created_at', 'desc')
      .execute();
    for (const row of rows) await this.evaluate(row.id, undefined, true);
  }

  /**
   * The answer of the card: a project of the catalog, a new project by name, or «Без проекта» (dismiss).
   * Returns true when a project was created (the caller refreshes the catalog of every window).
   */
  async answer(userId: string, id: string, a: ProjectSuggestionAnswer): Promise<{ created: boolean }> {
    const { db } = this.o;
    let created = false;
    await db.transaction().execute(async tx => {
      const session = await tx.selectFrom('sessions').select('id').where('user_id', '=', userId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!session) throw new HttpError(404, 'not_found', 'Session not found');
      const suggestion = await tx.selectFrom('project_suggestions').selectAll().where('user_id', '=', userId).where('session_id', '=', id).executeTakeFirst();
      if (!suggestion) throw new HttpError(404, 'not_found', 'Suggestion not found');
      if (suggestion.input_hash !== a.inputHash) throw new HttpError(409, 'stale_suggestion', 'Suggestion has changed');
      if (suggestion.state !== 'pending') return;
      if (a.action !== 'dismiss') {
        const current = await tx.selectFrom('session_projects').select('source').where('user_id', '=', userId).where('session_id', '=', id).executeTakeFirst();
        if (current?.source === 'manual' || current?.source === 'explicit') throw new HttpError(409, 'project_pinned', 'Project already selected');
        let projectId: string;
        if (a.action === 'accept') {
          const project = await tx.selectFrom('catalog_projects').select('id').where('id', '=', a.projectId).where('user_id', '=', userId).where('archived', '=', false).executeTakeFirst();
          if (!project) throw new HttpError(409, 'project_unavailable', 'Project unavailable');
          projectId = project.id;
        } else {
          await sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`.execute(tx);
          const taken = await tx.selectFrom('catalog_projects').select('id').where('user_id', '=', userId).where('archived', '=', false).where('name', '=', a.name).executeTakeFirst();
          if (taken) throw new HttpError(409, 'name_conflict', { key: 'hub.api.nameConflict' });
          const used = await tx.selectFrom('catalog_projects').select('color_key').where('user_id', '=', userId).where('archived', '=', false).execute();
          projectId = randomUUID();
          const colorKey = allocateProjectColor(
            used.map(p => p.color_key),
            projectId,
          );
          await tx.insertInto('catalog_projects').values({ id: projectId, user_id: userId, name: a.name, color_key: colorKey, description: '', remote: null }).execute();
          created = true;
        }
        await tx
          .insertInto('session_projects')
          .values({ user_id: userId, session_id: id, project_id: projectId, source: 'manual', confidence: null, reason_code: 'confirmed' })
          .onConflict(oc => oc.columns(['user_id', 'session_id']).doUpdateSet({ project_id: projectId, source: 'manual', confidence: null, reason_code: 'confirmed' }))
          .execute();
      }
      await tx
        .updateTable('project_suggestions')
        .set({ state: a.action === 'dismiss' ? 'dismissed' : 'accepted', updated_at: new Date() })
        .where('user_id', '=', userId)
        .where('session_id', '=', id)
        .execute();
    });
    await this.o.changed(id);
    return { created };
  }
}
