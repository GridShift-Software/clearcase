import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open, readlink, rm, type FileHandle } from 'node:fs/promises';
import { sep } from 'node:path';

export const within = (p: string, root: string) => {
	const pre = root.endsWith(sep) ? root : root + sep;
	return p === root || p.startsWith(pre);
};

export type Identity = { dev: string; ino: string; size: number; mtimeNs: string; ctimeNs: string };
export type Refusal = 'missing' | 'escape' | 'not-regular' | 'hardlink';
export type Opened = { fh: FileHandle; real: string; id: Identity };

export const procFdAvailable = () => existsSync('/proc/self/fd');

type BigStat = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint; isFile(): boolean };
export const identityOf = (st: BigStat): Identity => ({ dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) });
export const sameIdentity = (a: Identity, b: Partial<Identity> | null | undefined) =>
	!!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export async function openInside(path: string, root: string): Promise<Opened | { refused: Refusal; detail: string }> {
	let fh: FileHandle;
	// O_NONBLOCK: opening a FIFO must not hang; O_NOCTTY: a terminal device never becomes our controlling tty.
	try { fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY); }
	catch (e) { return { refused: 'missing', detail: (e as NodeJS.ErrnoException).code ?? String(e) }; }
	try {
		const real = await readlink(`/proc/self/fd/${fh.fd}`);
		if (!within(real, root) || real === root) { await fh.close(); return { refused: 'escape', detail: `opened file lies outside the folder: ${real}` }; }
		const st = (await fh.stat({ bigint: true })) as unknown as BigStat;
		if (!st.isFile()) { await fh.close(); return { refused: 'not-regular', detail: 'not a regular file' }; }
		if (st.nlink !== 1n) { await fh.close(); return { refused: st.nlink === 0n ? 'missing' : 'hardlink', detail: st.nlink === 0n ? 'deleted' : `${st.nlink} hard links (shares its content with another path)` }; }
		return { fh, real, id: identityOf(st) };
	} catch (e) {
		await fh.close().catch(() => {});
		return { refused: 'missing', detail: String((e as Error).message ?? e) };
	}
}

export async function changedSince(fh: FileHandle, before: Identity) {
	const now = identityOf((await fh.stat({ bigint: true })) as unknown as BigStat);
	return !sameIdentity(now, before);
}

export async function readAllFd(o: Opened): Promise<Buffer | null> {
	const buf = Buffer.alloc(o.id.size);
	let off = 0;
	while (off < buf.length) {
		const { bytesRead } = await o.fh.read(buf, off, buf.length - off, off);
		if (bytesRead === 0) return null;
		off += bytesRead;
	}
	const extra = await o.fh.read(Buffer.alloc(1), 0, 1, off);
	if (extra.bytesRead !== 0) return null; // longer than st_size (procfs, growing file)
	if (await changedSince(o.fh, o.id)) return null;
	return buf;
}

export async function forEachChunk(o: Opened, fn: (chunk: Buffer) => void | Promise<void>, chunkSize = 1 << 20): Promise<boolean> {
	let pos = 0;
	const buf = Buffer.alloc(chunkSize);
	for (;;) {
		const { bytesRead } = await o.fh.read(buf, 0, chunkSize, pos);
		if (bytesRead === 0) break;
		pos += bytesRead;
		if (pos > o.id.size) return false;
		await fn(Buffer.from(buf.subarray(0, bytesRead)));
	}
	return pos === o.id.size;
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export async function snapshotVerified(o: Opened, sha256: string, dest: string, signal?: AbortSignal): Promise<boolean> {
	const out = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	const h = createHash('sha256');
	let ok = false;
	try {
		let pos = 0;
		const complete = await forEachChunk(o, async (c) => {
			if (signal?.aborted) throw new Error('aborted');
			h.update(c);
			await out.write(c, 0, c.length, pos);
			pos += c.length;
		});
		ok = complete && !(await changedSince(o.fh, o.id)) && h.digest('hex') === sha256;
		if (ok) await out.sync();
	} catch {
		ok = false;
	} finally {
		await out.close().catch(() => {});
		if (!ok) await rm(dest, { force: true }).catch(() => {});
	}
	return ok;
}
