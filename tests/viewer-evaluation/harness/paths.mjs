// Where the harness writes: <worktree>/.local/viewer-evaluation (ignored by Git; screenshots and fixtures stay local).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitEnv } from '../../../scripts/browser-lock.mjs';

export const HERE = path.resolve(import.meta.dirname, '..');
export const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8', env: gitEnv() }).trim();
export const OUT_ROOT = path.join(REPO, '.local', 'viewer-evaluation');
