// Local operator tools the generators and the prepared-rendition path call. Every call runs offline: inside
// `unshare -rn` (a new user and network namespace with no interfaces), so a converter cannot reach the network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function run(cmd, args, { offline = true, cwd } = {}) {
  const [c, a] = offline ? ['unshare', ['-rn', cmd, ...args]] : [cmd, args];
  const r = spawnSync(c, a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, HOME: process.env.HOME } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(-600)}`);
  return r.stdout;
}

export function version(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || r.stderr).split('\n').find((l) => l.trim())?.trim() : null;
}

export const magick = (...args) => run('magick', args);
export const ffmpeg = (...args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** LibreOffice headless conversion with a throwaway profile; returns the converted file's bytes. */
export function soffice(input, filter, outDir, profile) {
  mkdirSync(outDir, { recursive: true });
  run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore', '--convert-to', filter, '--outdir', outDir, input]);
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const ext = filter.split(':')[0];
  const out = readdirSync(outDir).find((f) => f === `${base}.${ext}`);
  if (!out) throw new Error(`soffice produced no ${base}.${ext} in ${outDir}`);
  return readFileSync(path.join(outDir, out));
}
