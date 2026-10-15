// Runtime configuration of the local pilot, read from the environment once per service instance.
// The data directory holds results.sqlite, work.sqlite, backups and serve-time snapshots. It is
// $CLEARCASE_DATA_DIR, else ${XDG_DATA_HOME:-~/.local/share}/clearcase, always resolved to an absolute
// path. There is no repository-relative fallback: the app never writes next to its sources.
import os from 'node:os';
import path from 'node:path';

export interface LocalCaseConfig {
	dataDir: string;
	appPort: number;
	originalsPort: number;
	/** host name of the originals site: a site of its own, with its own cookie jar (RFC 6761 *.localhost) */
	originalsHostname: string;
	/** The origin written into originals links when the originals site is reached through a tunnel or proxy (ORIGINALS_PUBLIC_ORIGIN); null links to the site's own host */
	originalsPublicOrigin: string | null;
	/** never-activated candidates kept per case */
	keepCandidates: number;
	/** work.sqlite backups kept */
	keepBackups: number;
	/** debounce of the backup taken after a user-work write */
	userWorkBackupDelayMs: number;
	/** originals up to this size are verified in memory; larger ones through a snapshot in the data directory */
	bufferMaxBytes: number;
}

type Env = Record<string, string | undefined>;

/** XDG base directory spec: a relative XDG_DATA_HOME is invalid and ignored. */
export function resolveDataDir(env: Env = process.env): string {
	if (env.CLEARCASE_DATA_DIR) return path.resolve(env.CLEARCASE_DATA_DIR);
	const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(env.HOME || os.homedir(), '.local', 'share');
	return path.resolve(xdg, 'clearcase');
}

const int = (v: string | undefined, d: number, min = 0) => {
	const n = v === undefined || v === '' ? d : Number(v);
	if (!Number.isInteger(n) || n < min) throw new Error(`invalid integer setting: ${v}`);
	return n;
};

/** An http(s) origin with no path, query or fragment, or null. Anything else is refused loudly: a wrong value would put broken links on every document page. */
export function publicOrigin(v: string | undefined): string | null {
	if (!v) return null;
	let u: URL;
	try { u = new URL(v); } catch { throw new Error(`ORIGINALS_PUBLIC_ORIGIN is not a URL: ${v}`); }
	if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.pathname !== '/' || u.search || u.hash || u.username) throw new Error(`ORIGINALS_PUBLIC_ORIGIN must be an http(s) origin such as https://example.test, not ${v}`);
	return u.origin;
}

export function configFromEnv(env: Env = process.env): LocalCaseConfig {
	const appPort = int(env.PORT, 41101, 1);
	return {
		dataDir: resolveDataDir(env),
		appPort,
		originalsPort: int(env.ORIGINALS_PORT, appPort + 1, 1),
		originalsHostname: env.ORIGINALS_HOSTNAME || 'clearcase-originals.localhost',
		originalsPublicOrigin: publicOrigin(env.ORIGINALS_PUBLIC_ORIGIN),
		keepCandidates: int(env.CLEARCASE_KEEP_CANDIDATES, 3, 1),
		keepBackups: int(env.CLEARCASE_KEEP_BACKUPS, 10, 2),
		userWorkBackupDelayMs: int(env.CLEARCASE_USERWORK_BACKUP_DELAY_MS, 3000),
		bufferMaxBytes: int(env.CLEARCASE_BUFFER_MAX_BYTES, 32 * 1024 * 1024, 1),
	};
}

export const appOrigin = (c: Pick<LocalCaseConfig, 'appPort'>) => `http://127.0.0.1:${c.appPort}`;
export const originalsHost = (c: Pick<LocalCaseConfig, 'originalsHostname' | 'originalsPort'>) => `${c.originalsHostname}:${c.originalsPort}`;
export const originalsOrigin = (c: Pick<LocalCaseConfig, 'originalsHostname' | 'originalsPort'>) => `http://${originalsHost(c)}`;
