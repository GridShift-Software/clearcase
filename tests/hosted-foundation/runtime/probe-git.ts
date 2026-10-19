// Git for the disposable guard-probe checkouts: no host or guest git config is read, none is written, and the
// identity is explicit, so a runner user without user.name and user.email commits the same as a developer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(tmpdir(), 'probe-git-home-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
export const probeGitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(name)) delete env[name];
  return env;
};
const identity = ['-c', 'user.name=clearcase-guard-probe', '-c', 'user.email=guard-probe@clearcase.invalid', '-c', 'commit.gpgsign=false'];
export const probeGit = (args: string[], cwd: string) => execFileSync('git', [...identity, ...args], { cwd, env: probeGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
