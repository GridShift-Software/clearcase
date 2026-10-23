// Bun launcher; the existing reader alone reads clerk-dev.env and hands selected keys to real Node over fd 3.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { realNode } from '../identity/harness.ts';
import { ROOT } from './check.mjs';

const node = realNode();
const keys = 'CLIENT_A_PK,CLIENT_A_SK,CLIENT_C_PK,CLIENT_C_SK,STAFF_PK,STAFF_SK';
const child = spawn(process.execPath, [path.join(ROOT, 'deploy/probes/secrets.ts'), 'run', 'clerk-dev', '--keys', keys, '--', node.path, path.join(import.meta.dirname, 'probe.mjs')], { stdio: 'inherit', env: { ...process.env, PROBE_BUN: process.execPath } });
child.on('error', () => { console.error('isolation launcher failed'); process.exitCode = 2; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1)));
