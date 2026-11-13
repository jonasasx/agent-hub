// change session-machine-context, D2 (session-machine-context): the machine line in the session instructions.
import { describe, expect, it } from 'vitest';
import { MACHINE_NAME_MAX, renderMachineContext } from './machineContext.js';

describe('renderMachineContext', () => {
  it('the hub name and the hostname', () => {
    expect(renderMachineContext('X1', 'DESKTOP-7Q2')).toBe(
      'This session runs on the machine "X1" in Agent Hub (hostname DESKTOP-7Q2). When the user or another session refers to this machine, it is this one.',
    );
  });

  it('without a hub name (an older hub) — the hostname only', () => {
    expect(renderMachineContext(undefined, 'DESKTOP-7Q2')).toBe('This session runs on the machine with hostname DESKTOP-7Q2.');
    expect(renderMachineContext(' \n ', 'DESKTOP-7Q2')).toBe('This session runs on the machine with hostname DESKTOP-7Q2.');
  });

  it('one line, the name cut to the limit', () => {
    const text = renderMachineContext(`AWS\nVM ${'x'.repeat(500)}`, 'ip-10-0-0-3');
    expect(text).not.toContain('\n');
    expect(text).toContain('"AWS VM x');
    expect(text.match(/"([^"]*)"/)![1]!.length).toBe(MACHINE_NAME_MAX);
  });

  it('the OS hostname by default', async () => {
    const { hostname } = await import('node:os');
    expect(renderMachineContext('HP')).toContain(`(hostname ${hostname()})`);
  });
});
