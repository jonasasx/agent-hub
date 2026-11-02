// The registry of subagents (change `subagents`, design S1, S2): facts of the extractor applied to `subagent_runs`
// in the transaction of a chunk, under a lock of the session (chunks of the main and of subagent files of one session
// may come in parallel), the link of a call with its transcript and the merge of two rows; the views of the API.
// Requirement (subagents): Реестр субагентов сессии; Статус субагента.
import { sql, type Transaction } from 'kysely';
import { effectiveStatus, type HubEvent, type HubSubagentView, type SubagentState, type SubagentView } from '@agent-hub/shared';
import { decodeCursor, encodeCursor } from '../sessions/repo.js';
import { sideFileRefs } from '../replication/sideLinks.js';
import type { Database, Db } from '../db/db.js';
import type { Fact } from './extract.js';

type Tx = Transaction<Database>;

/** The lock of the registry of one session for the transaction (also taken by repl.agent_meta and the backfill). */
export async function lockRegistry(tx: Tx, sessionId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`subagent_runs:${sessionId}`}, 0))`.execute(tx);
}

/**
 * Is a fact with time `ts` not older than the row's state (review p. 3): a fact that changes the state applies only
 * when it is at least as late as the fact that set the current state, so chunks of different files in any order give
 * the same result. A fact without a time applies.
 */
const newer = (ts: Date | null) => sql<boolean>`(${ts}::timestamptz IS NULL OR state_at IS NULL OR state_at <= ${ts}::timestamptz)`;

/** Row of a call by its tool_use_id. */
async function byCall(tx: Tx, sessionId: string, toolUseId: string) {
  return tx.selectFrom('subagent_runs').selectAll().where('session_id', '=', sessionId).where('tool_use_id', '=', toolUseId).executeTakeFirst();
}
async function byAgent(tx: Tx, sessionId: string, agentId: string) {
  return tx.selectFrom('subagent_runs').selectAll().where('session_id', '=', sessionId).where('agent_id', '=', agentId).executeTakeFirst();
}

/**
 * The call row `keepId` gets the agent `agentId`; a separate row of that agent (made by its file or its meta.json)
 * is merged into it: its file, times, meta and a later state move over, then it is deleted. Returns the kept id.
 */
async function linkAgent(tx: Tx, sessionId: string, keepId: string, agentId: string): Promise<string> {
  const other = await byAgent(tx, sessionId, agentId);
  const keep = other && other.id !== keepId ? await tx.selectFrom('subagent_runs').select('tool_use_id').where('id', '=', keepId).executeTakeFirstOrThrow() : null;
  if (other && other.id !== keepId && other.tool_use_id && other.tool_use_id !== keep!.tool_use_id) {
    // the agent was linked to another call by mistake (by the prompt, before the result named it): that call keeps its
    // row and loses the agent and its transcript; the state it got from the agent's file stays (review p. 2)
    await tx
      .updateTable('subagent_runs')
      .set({ agent_id: null, file_id: null, updated_at: sql`now()` })
      .where('id', '=', other.id)
      .execute();
    await tx
      .updateTable('subagent_runs')
      .set({ agent_id: agentId, file_id: sql`COALESCE(file_id, ${other.file_id})`, updated_at: sql`now()` })
      .where('id', '=', keepId)
      .execute();
  } else if (other && other.id !== keepId) {
    await tx.deleteFrom('subagent_runs').where('id', '=', other.id).execute();
    await tx
      .updateTable('subagent_runs')
      .set({
        agent_id: agentId,
        file_id: sql`COALESCE(file_id, ${other.file_id})`,
        meta: sql`COALESCE(${other.meta === null ? null : JSON.stringify(other.meta)}::jsonb, meta)`,
        last_event_at: sql`GREATEST(last_event_at, ${other.last_event_at})`,
        started_at: sql`LEAST(started_at, ${other.started_at})`,
        parent_agent_id: sql`COALESCE(parent_agent_id, ${other.parent_agent_id})`,
        kind: other.kind === 'teammate' ? 'teammate' : sql`kind`,
        background: sql`background OR ${other.background}`,
        from_call: sql`from_call OR ${other.from_call}`,
        name: sql`COALESCE(name, ${other.name})`,
        description: sql`COALESCE(description, ${other.description})`,
        // the later of the two signs wins
        ...(other.state_at && other.state !== 'running'
          ? {
              state: sql`CASE WHEN state_at IS NULL OR state_at <= ${other.state_at} THEN ${other.state} ELSE state END`,
              state_at: sql`GREATEST(state_at, ${other.state_at})`,
              ended_at: sql`COALESCE(ended_at, ${other.ended_at})`,
            }
          : {}),
        updated_at: sql`now()`,
      })
      .where('id', '=', keepId)
      .execute();
  } else {
    await tx
      .updateTable('subagent_runs')
      .set({ agent_id: agentId, updated_at: sql`now()` })
      .where('id', '=', keepId)
      .execute();
  }
  return keepId;
}

/** Link (в): a file without a call and a call without an agent with the same task text — when the match is unique. */
async function linkByPrompt(tx: Tx, sessionId: string, fileRowId: string, agentId: string, promptSha: Buffer): Promise<string> {
  // a call that failed or already has its result is not waiting for a transcript (review p. 2)
  const calls = await tx
    .selectFrom('subagent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .where('agent_id', 'is', null)
    .where('tool_use_id', 'is not', null)
    .where('prompt_sha', '=', promptSha)
    .where('state', '<>', 'failed')
    .where('result_at', 'is', null)
    .limit(2)
    .execute();
  if (calls.length !== 1) return fileRowId;
  return linkAgent(tx, sessionId, calls[0]!.id, agentId);
}

/** A row of the agent (by its file, activity or meta), made when missing. */
async function ensureAgent(
  tx: Tx,
  userId: string,
  sessionId: string,
  agentId: string,
  fields: Partial<{ file_id: string | null; started_at: Date | null }> = {},
): Promise<{ id: string; created: boolean }> {
  const have = await byAgent(tx, sessionId, agentId);
  if (have) {
    if (fields.file_id && !have.file_id)
      await tx
        .updateTable('subagent_runs')
        .set({ file_id: fields.file_id, updated_at: sql`now()` })
        .where('id', '=', have.id)
        .execute();
    return { id: have.id, created: false };
  }
  const row = await tx
    .insertInto('subagent_runs')
    .values({ user_id: userId, session_id: sessionId, agent_id: agentId, file_id: fields.file_id ?? null, started_at: fields.started_at ?? null, state_at: fields.started_at ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, created: true };
}

/**
 * Applies the facts of one chunk of the session. `fileId` — the transcript the lines are from (a subagent file links
 * to its row). Returns the ids of the rows that changed (for subagent.upsert after the commit).
 */
export async function applyFacts(tx: Tx, o: { userId: string; sessionId: string; fileId: string | null }, facts: Fact[]): Promise<Set<string>> {
  const changed = new Set<string>();
  if (!facts.length) return changed;
  await lockRegistry(tx, o.sessionId);
  const sid = o.sessionId;
  for (const f of facts) {
    switch (f.t) {
      case 'call': {
        const row = await tx
          .insertInto('subagent_runs')
          .values({
            user_id: o.userId,
            session_id: sid,
            tool_use_id: f.toolUseId,
            parent_agent_id: f.parentAgentId,
            kind: f.kind,
            description: f.description,
            agent_type: f.agentType,
            name: f.name,
            team_name: f.teamName,
            background: f.background,
            from_call: true,
            prompt_sha: f.promptSha,
            started_at: f.ts,
            state_at: f.ts,
          })
          .onConflict(oc =>
            oc
              .columns(['session_id', 'tool_use_id'])
              .where('tool_use_id', 'is not', null)
              .doUpdateSet({
                // The call in a transcript beats meta.json (QA subagents): its type, description and parent come
                // first; the row may have been made by meta.json, which arrives before the call returns.
                description: sql`COALESCE(excluded.description, subagent_runs.description)`,
                agent_type: sql`COALESCE(excluded.agent_type, subagent_runs.agent_type)`,
                name: sql`COALESCE(subagent_runs.name, excluded.name)`,
                team_name: sql`COALESCE(subagent_runs.team_name, excluded.team_name)`,
                prompt_sha: sql`COALESCE(subagent_runs.prompt_sha, excluded.prompt_sha)`,
                parent_agent_id: sql`COALESCE(excluded.parent_agent_id, subagent_runs.parent_agent_id)`,
                // background is lost if the row came first from meta.json (default false) — QA: «background иногда false»
                background: sql`subagent_runs.background OR excluded.background`,
                from_call: true,
                started_at: sql`LEAST(subagent_runs.started_at, excluded.started_at)`,
                updated_at: sql`now()`,
              }),
          )
          .returning(['id', 'agent_id', 'state', 'result_at'])
          .executeTakeFirstOrThrow();
        let id = row.id;
        // (в) the transcript may have come first (a re-sent call that failed or has its result waits for none)
        if (!row.agent_id && f.promptSha && row.state !== 'failed' && !row.result_at) {
          const files = await tx
            .selectFrom('subagent_runs')
            .select(['id', 'agent_id'])
            .where('session_id', '=', sid)
            .where('tool_use_id', 'is', null)
            .where('agent_id', 'is not', null)
            .where('prompt_sha', '=', f.promptSha)
            .limit(2)
            .execute();
          if (files.length === 1) id = await linkAgent(tx, sid, id, files[0]!.agent_id!);
        }
        changed.add(id);
        break;
      }
      case 'result': {
        const call = await byCall(tx, sid, f.toolUseId);
        if (!call) break; // the result of another tool
        let id = call.id;
        if (f.agentId && call.agent_id !== f.agentId) id = await linkAgent(tx, sid, call.id, f.agentId);
        await tx
          .updateTable('subagent_runs')
          .set({
            ...(f.kind ? { kind: f.kind } : {}),
            ...(f.background ? { background: true } : {}),
            agent_type: sql`COALESCE(${f.agentType}, agent_type)`,
            model: sql`COALESCE(${f.model}, model)`,
            name: sql`COALESCE(name, ${f.name})`,
            team_name: sql`COALESCE(team_name, ${f.teamName})`,
            ...(f.durationMs !== null ? { duration_ms: String(f.durationMs) } : {}),
            ...(f.totalTokens !== null ? { total_tokens: String(f.totalTokens) } : {}),
            ...(f.toolUses !== null ? { tool_uses: String(f.toolUses) } : {}),
            result_at: sql`COALESCE(result_at, ${f.ts}::timestamptz, now())`,
            ...(f.state
              ? {
                  state: sql`CASE WHEN ${newer(f.ts)} THEN ${f.state} ELSE state END`,
                  ended_at: sql`CASE WHEN ${newer(f.ts)} THEN ${f.ts}::timestamptz ELSE ended_at END`,
                  state_at: sql`CASE WHEN ${newer(f.ts)} THEN ${f.ts}::timestamptz ELSE state_at END`,
                }
              : {}),
            updated_at: sql`now()`,
          })
          .where('id', '=', id)
          .execute();
        changed.add(id);
        break;
      }
      case 'bgcall': {
        // change `background-tasks` D2: the call's metadata; the row works only once the result names the task
        await tx
          .insertInto('background_tasks')
          .values({ session_id: sid, tool_use_id: f.toolUseId, state: 'pending', kind: f.kind, description: f.description, command: f.command, started_at: f.ts })
          .onConflict(oc =>
            oc.columns(['session_id', 'tool_use_id']).doUpdateSet({
              kind: f.kind,
              description: sql`COALESCE(background_tasks.description, ${f.description})`,
              command: sql`COALESCE(background_tasks.command, ${f.command})`,
            }),
          )
          .execute();
        break;
      }
      case 'bgstart': {
        // a call seen before (pending) starts; an end state already there stays (a chunk sent again)
        await tx
          .insertInto('background_tasks')
          .values({
            session_id: sid,
            tool_use_id: f.toolUseId,
            task_id: f.taskId,
            started_at: f.ts,
            kind: f.kind,
            timeout_ms: f.timeoutMs !== null ? String(f.timeoutMs) : null,
            persistent: f.persistent,
          })
          .onConflict(oc =>
            oc.columns(['session_id', 'tool_use_id']).doUpdateSet({
              state: sql`CASE WHEN background_tasks.state = 'pending' THEN 'running' ELSE background_tasks.state END`,
              task_id: f.taskId,
              kind: f.kind,
              started_at: sql`COALESCE(${f.ts}::timestamptz, background_tasks.started_at)`,
              timeout_ms: f.timeoutMs !== null ? String(f.timeoutMs) : null,
              persistent: f.persistent,
            }),
          )
          .execute();
        break;
      }
      case 'bgstop': {
        await tx.updateTable('background_tasks').set({ state: 'stopped', ended_at: f.ts }).where('session_id', '=', sid).where('task_id', '=', f.taskId).where('state', '=', 'running').execute();
        break;
      }
      case 'bgexpire': {
        await tx
          .updateTable('background_tasks')
          .set({ state: 'expired', ended_at: f.ts })
          .where('session_id', '=', sid)
          .where('task_id', '=', f.taskId)
          .where('kind', '=', 'monitor')
          .where('state', '=', 'running')
          .execute();
        break;
      }
      case 'bgevent': {
        // D3: the newest event wins, the same notification seen twice (queue and feed) changes nothing
        await tx
          .updateTable('background_tasks')
          .set({
            last_event: sql`CASE WHEN last_event_at IS NULL OR ${f.ts}::timestamptz >= last_event_at THEN ${f.text} ELSE last_event END`,
            last_event_at: sql`GREATEST(last_event_at, ${f.ts}::timestamptz)`,
          })
          .where('session_id', '=', sid)
          .where('task_id', '=', f.taskId)
          .where('kind', '=', 'monitor')
          .execute();
        break;
      }
      case 'notify': {
        // a background command (Bash/PowerShell) ends here; it has no registry row
        await tx
          .updateTable('background_tasks')
          .set({ state: f.state, ended_at: f.ts })
          .where('session_id', '=', sid)
          .where('state', '=', 'running')
          .where(eb => eb.or([...(f.toolUseId ? [eb('tool_use_id', '=', f.toolUseId)] : []), ...(f.agentId ? [eb('task_id', '=', f.agentId)] : [])]))
          .execute();
        // a task of the registry (a subagent)
        const rows = await tx
          .updateTable('subagent_runs')
          .set({ state: f.state, ended_at: f.ts, state_at: f.ts, updated_at: sql`now()` })
          .where('session_id', '=', sid)
          .where(eb => eb.or([...(f.agentId ? [eb('agent_id', '=', f.agentId)] : []), ...(f.toolUseId ? [eb('tool_use_id', '=', f.toolUseId)] : [])]))
          .where(newer(f.ts))
          .returning('id')
          .execute();
        for (const r of rows) changed.add(r.id);
        break;
      }
      case 'resume': {
        const rows = await tx
          .updateTable('subagent_runs')
          .set({ state: 'running', ended_at: null, state_at: f.ts, updated_at: sql`now()` })
          .where('session_id', '=', sid)
          .where('agent_id', '=', f.agentId)
          .where(newer(f.ts))
          .returning('id')
          .execute();
        for (const r of rows) changed.add(r.id);
        break;
      }
      case 'file': {
        const r = await ensureAgent(tx, o.userId, sid, f.agentId, { file_id: o.fileId, started_at: f.ts });
        await tx
          .updateTable('subagent_runs')
          .set({
            prompt_sha: sql`COALESCE(prompt_sha, ${f.promptSha})`,
            started_at: sql`LEAST(started_at, ${f.ts})`,
            description: sql`COALESCE(description, ${f.description})`,
            ...(f.teammate ? { kind: 'teammate', name: sql`COALESCE(name, ${f.teammate.name})`, agent_type: sql`COALESCE(agent_type, ${f.teammate.name})` } : {}),
            updated_at: sql`now()`,
          })
          .where('id', '=', r.id)
          .execute();
        let id = r.id;
        const row = await tx.selectFrom('subagent_runs').select(['tool_use_id']).where('id', '=', id).executeTakeFirstOrThrow();
        if (!row.tool_use_id && f.promptSha) id = await linkByPrompt(tx, sid, id, f.agentId, f.promptSha);
        changed.add(id);
        break;
      }
      case 'activity': {
        const r = await ensureAgent(tx, o.userId, sid, f.agentId, { file_id: o.fileId, started_at: f.ts });
        const rows = await tx
          .updateTable('subagent_runs')
          .set({
            last_event_at: sql`GREATEST(last_event_at, ${f.ts})`,
            started_at: sql`COALESCE(started_at, ${f.ts})`,
            // a new message or answer after an end or an idle: it works again
            ...(f.resumes && f.ts
              ? {
                  state: sql`CASE WHEN state <> 'running' AND (state_at IS NULL OR state_at < ${f.ts}) THEN 'running' ELSE state END`,
                  ended_at: sql`CASE WHEN state <> 'running' AND (state_at IS NULL OR state_at < ${f.ts}) THEN NULL ELSE ended_at END`,
                  state_at: sql`CASE WHEN state <> 'running' AND (state_at IS NULL OR state_at < ${f.ts}) THEN ${f.ts} ELSE state_at END`,
                }
              : {}),
          })
          .where('id', '=', r.id)
          .returning(['id', 'state'])
          .execute();
        for (const x of rows) changed.add(x.id);
        break;
      }
      case 'hook': {
        const r = await ensureAgent(tx, o.userId, sid, f.agentId, { file_id: o.fileId });
        await tx
          .updateTable('subagent_runs')
          .set({
            // SubagentStop does not overwrite a failure or a stop; TeammateIdle is a pause, not an end
            // an older hook than the current state (a late chunk) changes nothing but the activity time
            state:
              f.state === 'completed' ? sql`CASE WHEN NOT ${newer(f.ts)} OR state IN ('failed', 'stopped') THEN state ELSE 'completed' END` : sql`CASE WHEN ${newer(f.ts)} THEN 'idle' ELSE state END`,
            ended_at:
              f.state === 'completed' ? sql`CASE WHEN ${newer(f.ts)} THEN COALESCE(ended_at, ${f.ts}::timestamptz) ELSE ended_at END` : sql`CASE WHEN ${newer(f.ts)} THEN NULL ELSE ended_at END`,
            state_at: sql`CASE WHEN ${newer(f.ts)} THEN ${f.ts}::timestamptz ELSE state_at END`,
            last_event_at: sql`GREATEST(last_event_at, ${f.ts})`,
            updated_at: sql`now()`,
          })
          .where('id', '=', r.id)
          .execute();
        changed.add(r.id);
        break;
      }
    }
  }
  return changed;
}

/**
 * repl.agent_meta (design S5): the fields of `agent-<agentId>.meta.json`; `toolUseId` links the agent to its call
 * (б) before the call returns. Returns the ids of changed rows.
 */
export async function applyMeta(tx: Tx, o: { userId: string; sessionId: string }, agentId: string, meta: Record<string, unknown>): Promise<Set<string>> {
  await lockRegistry(tx, o.sessionId);
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  let { id } = await ensureAgent(tx, o.userId, o.sessionId, agentId);
  const toolUseId = s(meta.toolUseId);
  if (toolUseId) {
    const call = await byCall(tx, o.sessionId, toolUseId);
    if (call && call.id !== id) id = await linkAgent(tx, o.sessionId, call.id, agentId);
    else if (!call) await tx.updateTable('subagent_runs').set({ tool_use_id: toolUseId }).where('id', '=', id).where('tool_use_id', 'is', null).execute();
  }
  const teammate = meta.taskKind === 'in_process_teammate';
  // The call in a transcript has priority where it exists (from_call); a row known only from its own file (a nested
  // subagent whose call is in no transcript the hub has) takes type, description and parent from meta.json instead of
  // the first 80 characters of its prompt (QA subagents, session 63ca55c8).
  const pick = (col: 'agent_type' | 'description' | 'parent_agent_id', v: string | null) =>
    sql<string | null>`CASE WHEN from_call THEN COALESCE(${sql.ref(col)}, ${v}) ELSE COALESCE(${v}, ${sql.ref(col)}) END`;
  await tx
    .updateTable('subagent_runs')
    .set({
      meta: JSON.stringify(meta),
      agent_type: pick('agent_type', s(meta.agentType)),
      description: pick('description', s(meta.description)),
      // a call seen in a transcript fixes the parent, also when it is the session itself (null)
      parent_agent_id: sql<string | null>`CASE WHEN from_call THEN parent_agent_id ELSE COALESCE(${s(meta.parentAgentId)}, parent_agent_id) END`,
      ...(meta.requestShape === 'background' ? { background: true } : {}),
      name: sql`COALESCE(name, ${s(meta.name)})`,
      team_name: sql`COALESCE(team_name, ${s(meta.teamName)})`,
      model: sql`COALESCE(model, ${s(meta.model)})`,
      ...(teammate ? { kind: 'teammate' } : {}),
      ...(meta.finished === true ? { state: sql`CASE WHEN state IN ('failed', 'stopped') THEN state ELSE 'completed' END` } : {}),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute();
  return new Set([id]);
}

// ---------- views ----------

interface ViewRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  tool_use_id: string | null;
  parent_agent_id: string | null;
  parent_id: string | null;
  kind: SubagentView['kind'];
  description: string | null;
  agent_type: string | null;
  name: string | null;
  model: string | null;
  background: boolean;
  state: SubagentState;
  started_at: Date | null;
  last_event_at: Date | null;
  ended_at: Date | null;
  duration_ms: string | null;
  total_tokens: string | null;
  tool_uses: string | null;
  file_id: string | null;
  event_count: string | null;
  session_title: string;
  session_alive: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const n = (v: string | null) => (v === null ? null : Number(v));

/**
 * meta.json of a session the hub does not know yet waits in pending_agent_meta (QA subagents: the agent re-sends meta
 * only for 24 h, so a meta that came before the session's first chunk was lost for history).
 */
export async function holdAgentMeta(db: Db, runnerId: string, claudeSessionId: string, agentId: string, meta: Record<string, unknown>): Promise<void> {
  await db
    .insertInto('pending_agent_meta')
    .values({ runner_id: runnerId, claude_session_id: claudeSessionId, agent_id: agentId, meta: JSON.stringify(meta) })
    .onConflict(oc => oc.columns(['runner_id', 'claude_session_id', 'agent_id']).doUpdateSet({ meta: JSON.stringify(meta), received_at: sql`now()` }))
    .execute();
}

/** meta.json kept longer than this for a session that never appeared is dropped (hourly cleanup of the hub). */
export const HELD_META_TTL_MS = 30 * 24 * 3600_000;

/** Deletes held meta.json older than HELD_META_TTL_MS; returns how many. */
export async function expireHeldMeta(db: Db, now = new Date()): Promise<number> {
  const r = await db
    .deleteFrom('pending_agent_meta')
    .where('received_at', '<', new Date(now.getTime() - HELD_META_TTL_MS))
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

/**
 * Applies the meta.json of a session that waited for it and the meta already stored on its rows (backfill: the rows'
 * type, description and parent are recomputed by the meta rule after a rescan). Returns the changed row ids.
 */
export async function applyHeldMeta(tx: Tx, o: { userId: string; sessionId: string; runnerId: string; claudeSessionId: string }): Promise<Set<string>> {
  const changed = new Set<string>();
  const held = await tx.deleteFrom('pending_agent_meta').where('runner_id', '=', o.runnerId).where('claude_session_id', '=', o.claudeSessionId).returning(['agent_id', 'meta']).execute();
  const stored = await tx.selectFrom('subagent_runs').select(['agent_id', 'meta']).where('session_id', '=', o.sessionId).where('agent_id', 'is not', null).where('meta', 'is not', null).execute();
  const seen = new Set<string>();
  for (const m of [...held, ...stored]) {
    if (!m.agent_id || seen.has(m.agent_id) || !m.meta || typeof m.meta !== 'object') continue;
    seen.add(m.agent_id);
    for (const id of await applyMeta(tx, { userId: o.userId, sessionId: o.sessionId }, m.agent_id, m.meta as Record<string, unknown>)) changed.add(id);
  }
  return changed;
}

export function toSubagentView(r: ViewRow): SubagentView {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    toolUseId: r.tool_use_id,
    parentAgentId: r.parent_agent_id,
    parentId: r.parent_id,
    kind: r.kind,
    description: r.description,
    agentType: r.agent_type,
    name: r.name,
    model: r.model,
    background: r.background,
    status: effectiveStatus(r.state, r.session_alive),
    startedAt: iso(r.started_at),
    lastEventAt: iso(r.last_event_at),
    endedAt: iso(r.ended_at),
    durationMs: n(r.duration_ms),
    totalTokens: n(r.total_tokens),
    toolUses: n(r.tool_uses),
    eventCount: Number(r.event_count ?? 0),
    hasTranscript: r.file_id !== null,
    session: { id: r.session_id, title: r.session_title },
  };
}

/** The window of «running outside the hub» (as SessionView.externalActive, D9 p. 10b of the MVP). */
const EXTERNAL_WINDOW = sql`interval '3 minutes'`;

function viewQuery(db: Db) {
  return db
    .selectFrom('subagent_runs as r')
    .innerJoin('sessions as s', 's.id', 'r.session_id')
    .leftJoin('transcript_files as f', 'f.id', 'r.file_id')
    .select([
      'r.id',
      'r.session_id',
      'r.agent_id',
      'r.tool_use_id',
      'r.parent_agent_id',
      'r.kind',
      'r.description',
      'r.agent_type',
      'r.name',
      'r.model',
      'r.background',
      'r.state',
      'r.started_at',
      'r.last_event_at',
      'r.ended_at',
      'r.duration_ms',
      'r.total_tokens',
      'r.tool_uses',
      'r.file_id',
      'f.acked_line as event_count',
      's.title as session_title',
      sql<string | null>`(SELECT p.id FROM subagent_runs p WHERE p.session_id = r.session_id AND p.agent_id = r.parent_agent_id)`.as('parent_id'),
      sql<boolean>`(s.process_alive OR (s.external_seen_at IS NOT NULL AND s.external_seen_at > now() - ${EXTERNAL_WINDOW}))`.as('session_alive'),
    ]);
}

/** GET /api/sessions/:id/subagents: the registry of the session by started_at (the owner is checked by the caller). */
export async function listSubagents(db: Db, sessionId: string): Promise<SubagentView[]> {
  const rows = await viewQuery(db)
    .where('r.session_id', '=', sessionId)
    .orderBy(sql`r.started_at NULLS LAST`)
    .orderBy('r.id')
    .execute();
  return rows.map(r => toSubagentView(r as unknown as ViewRow));
}

/** One row of the user; null — none or another user's. */
export async function getSubagent(db: Db, userId: string, id: string): Promise<SubagentView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await viewQuery(db).where('r.id', '=', id).where('r.user_id', '=', userId).executeTakeFirst();
  return r ? toSubagentView(r as unknown as ViewRow) : null;
}

/** Views of rows by id (for subagent.upsert). */
export async function subagentViews(db: Db, ids: string[]): Promise<SubagentView[]> {
  if (!ids.length) return [];
  const rows = await viewQuery(db).where('r.id', 'in', ids).execute();
  return rows.map(r => toSubagentView(r as unknown as ViewRow));
}

/** Row of a subagent file (for subagent.events); null — the file has no row yet. */
export async function runOfFile(db: Db, fileId: string): Promise<{ id: string; user_id: string } | null> {
  return (await db.selectFrom('subagent_runs').select(['id', 'user_id']).where('file_id', '=', fileId).executeTakeFirst()) ?? null;
}

/** agenthub_subagent_unlinked: transcripts of subagents with neither a call nor a meta.json. */
export async function countUnlinked(db: Db): Promise<number> {
  const r = await db
    .selectFrom('subagent_runs')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('file_id', 'is not', null)
    .where('tool_use_id', 'is', null)
    .where('meta', 'is', null)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

/**
 * GET /api/subagents/:id/events (design S7): the transcript of the subagent page by page from the end, like the chat of
 * a session but only its file (no notes, no permission requests). A row without a file: an empty page.
 */
export async function subagentEventsPage(db: Db, run: { fileId: string | null; sessionId: string }, before: string | undefined, limit: number): Promise<{ events: HubEvent[]; before: string | null }> {
  if (!run.fileId) return { events: [], before: null };
  const c = decodeCursor(before);
  const rows = await db
    .selectFrom('events as e')
    .innerJoin('transcript_files as tf', j => j.onRef('tf.id', '=', 'e.file_id').onRef('tf.generation', '=', 'e.generation'))
    .select(['e.file_id', 'e.generation', 'e.line_no', 'e.ts', 'e.payload'])
    .where('e.file_id', '=', run.fileId)
    .$if(!!c, q => q.where('e.line_no', '<', c!.s))
    .orderBy('e.line_no', 'desc')
    .limit(limit + 1)
    .execute();
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const events = page.map((r): HubEvent => {
    const sideFiles = sideFileRefs(run.sessionId, r.payload);
    return { kind: 'line', id: `l:${r.file_id}:${r.generation}:${r.line_no}`, ts: r.ts.toISOString(), line: r.payload as Record<string, unknown>, ...(sideFiles ? { sideFiles } : {}) };
  });
  const oldest = page[0];
  return { events, before: more && oldest ? encodeCursor({ t: oldest.ts.toISOString(), k: 0, s: String(oldest.line_no) }) : null };
}

/** The file and the session of a row of the user (for its events); null — none or another user's. */
export async function runFile(db: Db, userId: string, id: string): Promise<{ fileId: string | null; sessionId: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.selectFrom('subagent_runs').select(['file_id', 'session_id']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  return r ? { fileId: r.file_id, sessionId: r.session_id } : null;
}

/** hub-subagents D7: the child hub sessions of a session (session_spawn), by creation. */
export async function listHubChildren(db: Db, userId: string, sessionId: string): Promise<HubSubagentView[]> {
  const rows = await db
    .selectFrom('sessions as s')
    .innerJoin('runners as r', 'r.id', 's.runner_id')
    .select(['s.id', 's.title', 's.provider', 's.runner_id', 'r.name as machine', 's.status', 's.process_alive', 's.created_at'])
    .where('s.user_id', '=', userId)
    .where('s.spawned_by', '=', sessionId)
    .orderBy('s.created_at')
    .execute();
  return rows.map(r => ({
    id: r.id,
    title: r.title ?? '',
    provider: r.provider,
    runnerId: r.runner_id,
    machine: r.machine,
    status: r.status,
    processAlive: r.process_alive,
    createdAt: r.created_at.toISOString(),
  }));
}
