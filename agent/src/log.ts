// One JSON line per event on stdout (journald / Task Scheduler log redirection).
// Secrets are never passed to the logger; `redact` is a second line of defence for the agent token.

export type Level = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { level: Level; redact?: string[]; write?: (line: string) => void }): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const secrets = (opts.redact ?? []).filter(s => s.length >= 8);
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] > ORDER[opts.level]) return;
    let line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    for (const s of secrets) line = line.split(s).join('[redacted]');
    write(line);
  };
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
  };
}
