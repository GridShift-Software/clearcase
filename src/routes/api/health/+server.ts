import { json } from '@sveltejs/kit';
import { app, instance } from '$lib/local-case/app.server';
import type { RequestHandler } from './$types';

// Diagnostics and instance identity for the live doctor: which process, build, data directory and ports answer here.
export const GET: RequestHandler = () => {
	const i = instance();
	const a = app();
	return json({
		instance: { id: i.id, pid: process.pid, startedAt: i.startedAt, bun: process.versions.bun ?? null, dataDir: a.config.dataDir, appPort: a.config.appPort, originalsPort: a.config.originalsPort, originalsOrigin: i.originals.origin, build: i.build },
		pragmas: a.storage.pragmas, storageError: a.storageError, recovery: a.anyRecovery() ?? null, warnings: [...a.warnings.keys()], startup: a.startupReport,
		pdfjs: i.originals.pdfjs?.pdfjsVersion ?? null,
	}, { headers: { 'cache-control': 'no-store' } });
};
