// The machine of a session in its instructions (change session-machine-context, D2): the hub sends the machine's hub
// name in session.start/resume (protocol 1.19), the agent adds it with the OS hostname to Claude's system prompt and
// Codex's developer instructions. Requirement (session-machine-context): Имя машины в контексте сессии.
import os from 'node:os';

export const MACHINE_NAME_MAX = 200;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** One line naming the machine of the session; without a hub name — the hostname only. */
export function renderMachineContext(machineName: string | undefined, hostname: string = os.hostname()): string {
  const host = oneLine(hostname);
  const name = machineName ? oneLine(machineName).slice(0, MACHINE_NAME_MAX) : '';
  if (!name) return `This session runs on the machine with hostname ${host}.`;
  return `This session runs on the machine "${name}" in Agent Hub (hostname ${host}). When the user or another session refers to this machine, it is this one.`;
}
