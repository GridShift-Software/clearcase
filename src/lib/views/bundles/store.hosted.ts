import { fail } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type * as C from '../../server/runtime/contracts.ts';
import {
	hostedWork,
	guarded as adapterGuarded,
} from '../hosted/work-adapter.server.ts';
import {
	customOf,
	nextCustomNo,
	toBundle,
	type Custom,
} from '../../bundles/builder.ts';
import { contractError } from '../../server/runtime/errors.ts';
export const OWNER = 'GRS-19',
	CUSTOM_TABLE = 'bundles_custom',
	MARK_TABLE = 'bundles_schedule_mark';
export const HEADER_STORE = 'bundle-header',
	MODE_STORE = 'discovery-mode',
	LINKS_STORE = 'caselines-links';
export const fieldsHash = (v: unknown) =>
	createHash('sha256')
		.update(JSON.stringify(v ?? null))
		.digest('hex')
		.slice(0, 24);
export const customRows = (
	rows: readonly {
		cells: Record<string, C.TableCell>;
		version: C.WorkVersion;
	}[],
) =>
	rows
		.flatMap(({ cells: r, version }) => {
			let rows: unknown;
			try {
				rows = JSON.parse(String(r.rows ?? '[]'));
			} catch {
				return [];
			}
			const c = customOf({
				no: r.no,
				name: r.name,
				pages: r.pages,
				indexPages: r.index_pages,
				filePages: r.file_pages,
				note: r.note,
				rows,
			});
			return c
				? [
						{
							...c,
							id: String(r.id),
							seq: Number(r.seq) || 0,
							version,
							assembledSha256:
								typeof r.assembled_sha256 === 'string'
									? r.assembled_sha256
									: null,
							bytes: Number(r.bytes) || 0,
						},
					]
				: [];
		})
		.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
export { toBundle };
export function bundleStore(locals: C.RequestServices, scope: C.VersionScope) {
	const { caseId, resultsVersion } = scope;
	const table = (name: string) =>
		locals.userWork.listTableRows({ caseId, table: name });
	const registers = (store: string) =>
		locals.userWork.listRows({ caseId, store });
	async function putSingle(
		store: string,
		fields: C.Fields,
		expected?: C.Versioned<C.WorkRegisterRow> | null,
	) {
		const old = expected === undefined ? (await registers(store))[0] : expected;
		const form = new FormData();
		if (old) form.set('version', old.version);
		await hostedWork(locals, caseId, resultsVersion, form).putRow(
			caseId,
			store,
			old?.rowId ?? null,
			fields,
		);
	}
	/**
	 * Saves a custom bundle's row. `commitAfter` is the assembled PDF's object write: the row is read, authorized and
	 * prepared beside it, and commits only once the object is stored, so a saved row never names a missing PDF.
	 */
	async function putCustom(
		id: string,
		c: Custom,
		shipped: readonly { no: string }[],
		assembled?: { sha256: string; bytes: number },
		commitAfter?: Promise<unknown>,
	) {
		const rows = customRows(await table(CUSTOM_TABLE));
		const old = rows.find((r) => r.id === id);
		const no = old?.no ?? nextCustomNo(rows, shipped),
			seq = old?.seq ?? Math.max(0, ...rows.map((r) => r.seq)) + 1;
		const result = await locals.userWork.putTableRow({
			caseId,
			table: CUSTOM_TABLE,
			owner: OWNER,
			row: {
				case_id: caseId,
				id,
				no,
				name: c.name,
				pages: c.pages,
				index_pages: c.indexPages,
				file_pages: c.filePages,
				note: c.note,
				rows: JSON.stringify(c.rows),
				seq,
				assembled_sha256: assembled?.sha256 ?? old?.assembledSha256 ?? null,
				bytes: assembled?.bytes ?? old?.bytes ?? null,
			},
			expected: old
				? { kind: 'match', version: old.version }
				: { kind: 'absent' },
			operationId: crypto.randomUUID(),
			...(commitAfter ? { commitAfter } : {}),
		});
		if (result.kind !== 'written') throw contractError(result.kind);
		return no;
	}
	async function deleteCustom(id: string) {
		const old = (await table(CUSTOM_TABLE)).find((r) => r.cells.id === id);
		if (!old) return;
		const result = await locals.userWork.deleteTableRow({
			caseId,
			table: CUSTOM_TABLE,
			owner: OWNER,
			key: { case_id: caseId, id },
			expected: { kind: 'match', version: old.version },
			operationId: crypto.randomUUID(),
		});
		if (result.kind !== 'written') throw contractError(result.kind);
	}
	return { table, registers, putSingle, putCustom, deleteCustom };
}
export async function guarded<T>(write: () => Promise<T>) {
	const r = await adapterGuarded('bundle', null, write, {
		busy: 'Not saved: the case store is busy. Retry.',
		failed: 'Not saved. Try again.',
		refused: 'Not saved: check the form and try again.',
	});
	return r.ok ? r.value : r.failure;
}
