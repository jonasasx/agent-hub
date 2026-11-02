// Entry of dist/cli.mjs (`~/.agent-hub/bin/agent-hub`).
import { readSecretFromTty, runCli, stateDirFrom } from './cli.js';

runCli(process.argv.slice(2), {
  stateDir: stateDirFrom(),
  env: process.env,
  io: { out: s => process.stdout.write(s), err: s => process.stderr.write(s), readSecret: readSecretFromTty },
}).then(
  code => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
