// Agent entry point: forked by supervisor.mjs (Windows task, env from agent.env) or run by systemd (Linux, EnvironmentFile).
import { loadAgentConfig } from './config.js';
import { createLogger } from './log.js';
import { AGENT_VERSION } from './machine.js';
import { createAgent } from './agent.js';
import { checkClaude, findClaude } from './claudeStatus.js';
import { checkProtectedDirs } from './macos.js';

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const log = createLogger({ level: config.logLevel, redact: [config.token] });
  // A crash must end the process: the launcher (supervisor.mjs on Windows / systemd on Linux) starts a fresh one.
  process.on('uncaughtException', err => {
    log.error('uncaught exception, exiting', { error: err.stack ?? String(err) });
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    log.error('unhandled rejection, exiting', { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
    process.exit(1);
  });
  log.info('agent starting', { version: AGENT_VERSION, hub: config.hubUrl, vaultRoot: config.vaultRoot, pid: process.pid });

  // Claude Code sessions are children of this process: they must not inherit the agent token.
  delete process.env.AGENT_TOKEN;

  // 1.5 (multi-user M4): the login of claude and the macOS protected folders go in hello.
  const claude = await checkClaude({ claudePath: findClaude() }).catch(() => undefined);
  const protectedDirs = checkProtectedDirs();
  log.info('machine checked', { claudeLogin: claude?.login, claudeVersion: claude?.version, protectedDirs });
  // AGENT_HUB_APP_DIR is set by supervisor.mjs: only then can the agent replace itself (design M5).
  const appDir = process.send && process.env.AGENT_HUB_APP_DIR ? process.env.AGENT_HUB_APP_DIR : null;

  const agent = createAgent({
    hubUrl: config.hubUrl,
    token: config.token,
    vaultRoot: config.vaultRoot,
    claudeProjectsDir: config.claudeProjectsDir,
    stateDir: config.stateDir,
    replMaxBytesPerSec: config.replMaxBytesPerSec,
    replHistoryInflight: config.replHistoryInflight,
    log,
    status: { ...(claude ? { claude } : {}), protectedDirs },
    appDir,
    // The supervisor waits for this after starting a staged update (rollback otherwise).
    onWelcome: () => process.send?.({ type: 'ready', version: AGENT_VERSION }),
    restart: () => stop('update', 10_000),
  });
  agent.start();

  let stopping = false;
  /** Ends the Claude Code processes first: on Windows a child outlives its parent. */
  const stop = async (reason: string, graceMs: number) => {
    if (stopping) return;
    stopping = true;
    log.info('agent stopping', { reason });
    setTimeout(() => process.exit(0), graceMs + 3000).unref();
    await agent.stop(graceMs);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM', 10_000));
  process.on('SIGINT', () => void stop('SIGINT', 10_000));
  // Started by supervisor.mjs (Windows task): when the supervisor is gone (Stop-ScheduledTask terminates it),
  // stop the sessions and exit, so stopping the task leaves no agent and no Claude Code processes behind.
  if (process.send) process.on('disconnect', () => void stop('supervisor gone', 3000));
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
