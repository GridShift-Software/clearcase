import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFromEnv, resolveDataDir } from './config.server.ts';

describe('data directory', () => {
	it('uses CLEARCASE_DATA_DIR, made absolute', () => {
		expect(resolveDataDir({ CLEARCASE_DATA_DIR: '/srv/cc' })).toBe('/srv/cc');
		expect(resolveDataDir({ CLEARCASE_DATA_DIR: 'rel/dir' })).toBe(path.resolve('rel/dir'));
	});
	it('defaults to ${XDG_DATA_HOME:-~/.local/share}/clearcase and ignores a relative XDG_DATA_HOME', () => {
		expect(resolveDataDir({ XDG_DATA_HOME: '/x/data', HOME: '/home/u' })).toBe('/x/data/clearcase');
		expect(resolveDataDir({ HOME: '/home/u' })).toBe('/home/u/.local/share/clearcase');
		expect(resolveDataDir({ XDG_DATA_HOME: 'relative', HOME: '/home/u' })).toBe('/home/u/.local/share/clearcase');
	});
	it('reads ports and limits, rejecting invalid integers', () => {
		const c = configFromEnv({ CLEARCASE_DATA_DIR: '/d', PORT: '5000' });
		expect([c.appPort, c.originalsPort, c.originalsHostname, c.keepCandidates, c.keepBackups, c.bufferMaxBytes]).toEqual([5000, 5001, 'clearcase-originals.localhost', 3, 10, 32 * 1024 * 1024]);
		expect(() => configFromEnv({ CLEARCASE_DATA_DIR: '/d', PORT: 'x' })).toThrow();
		expect(() => configFromEnv({ CLEARCASE_DATA_DIR: '/d', CLEARCASE_KEEP_BACKUPS: '1' })).toThrow();
	});
});

describe('ORIGINALS_PUBLIC_ORIGIN', () => {
	it('an http(s) origin is kept as the links origin; absent means the site itself', () => {
		expect(configFromEnv({ CLEARCASE_DATA_DIR: '/d', ORIGINALS_PUBLIC_ORIGIN: 'https://tour.example.test' }).originalsPublicOrigin).toBe('https://tour.example.test');
		expect(configFromEnv({ CLEARCASE_DATA_DIR: '/d', ORIGINALS_PUBLIC_ORIGIN: 'https://tour.example.test/' }).originalsPublicOrigin).toBe('https://tour.example.test');
		expect(configFromEnv({ CLEARCASE_DATA_DIR: '/d' }).originalsPublicOrigin).toBeNull();
	});
	it('a path, a query, a user or a non-http scheme is refused', () => {
		for (const v of ['https://x.test/view', 'https://x.test/?k=1', 'https://u@x.test', 'ftp://x.test', 'x.test', 'https://x.test/#a'])
			expect(() => configFromEnv({ CLEARCASE_DATA_DIR: '/d', ORIGINALS_PUBLIC_ORIGIN: v }), v).toThrow();
	});
});
