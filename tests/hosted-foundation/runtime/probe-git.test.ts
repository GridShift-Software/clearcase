import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeGit, probeGitEnv } from './probe-git.ts';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('guard-probe git on a runner with no git identity', () => {
  it('commits in a disposable repository with HOME empty, no global config and no GIT_* identity in the environment', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'ambient', GIT_COMMITTER_EMAIL: 'ambient@example.invalid' });
    try {
      const repo = await mkdtemp(path.join(tmpdir(), 'probe-git-')); dirs.push(repo);
      const env = probeGitEnv();
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_AUTHOR_NAME).toBeUndefined();
      // the premise: without the explicit identity, git refuses in exactly this environment
      execFileSync('git', ['init', '--quiet'], { cwd: repo, env });
      await writeFile(path.join(repo, 'a.txt'), 'a\n');
      execFileSync('git', ['add', '.'], { cwd: repo, env });
      expect(() => execFileSync('git', ['commit', '--quiet', '-m', 'x'], { cwd: repo, env, stdio: 'pipe' })).toThrow(/identity unknown|empty ident/i);
      probeGit(['commit', '--quiet', '-m', 'probe'], repo);
      expect(probeGit(['log', '-1', '--format=%an <%ae> | %cn <%ce>'], repo)).toBe('clearcase-guard-probe <guard-probe@clearcase.invalid> | clearcase-guard-probe <guard-probe@clearcase.invalid>');
    } finally { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); }
  });
});
