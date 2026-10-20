// The synthetic two-client fixture of the hosted gate, as local D1 rows and R2 objects (GRS-112, for GRS-138).
// Synthetic only: two clients, three cases, four identities and four small originals invented here. `start:hosted`
// applies `sql` with `wrangler d1 execute --local` and writes each object with `wrangler r2 object put --local`; the
// hosted-gate test doubles (src/lib/server/runtime/hosted/gate/) read them. Client A's deployment sees B's rows only as
// another client's: a B session is wrong-client there, and B's case and asset ids are not found.
import { createHash } from 'node:crypto';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string | number | null) => (value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`);
const rows = (table: string, items: Record<string, string | number | null>[]) => items.map((r) => `INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(quote).join(', ')});`);

/** A one-page PDF whose only text is `label`. */
function pdf(label: string): Uint8Array {
	const stream = `BT /F1 18 Tf 20 100 Td (${label}) Tj ET`;
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
	let out = '%PDF-1.4\n';
	const offsets = objects.map((body, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

export const CLIENTS = [
	{ client_id: 'client-a', issuer: 'https://client-a.example.invalid' },
	{ client_id: 'client-b', issuer: 'https://client-b.example.invalid' },
];
export const IDENTITIES = [
	{ client_id: 'client-a', subject: 'a-viewer', kind: 'client', label: 'Client A viewer (case A1)' },
	{ client_id: 'client-a', subject: 'a-editor', kind: 'client', label: 'Client A editor (cases A1 and A2)' },
	{ client_id: 'client-a', subject: 'a-unassigned', kind: 'client', label: 'Client A member with no case' },
	{ client_id: 'client-b', subject: 'b-editor', kind: 'client', label: 'Client B editor (case B1)' },
];
export const CASES = [
	{ client_id: 'client-a', case_id: 'case-a1', case_label: 'Synthetic matter A1', publication: 'none', results_version: null },
	{ client_id: 'client-a', case_id: 'case-a2', case_label: 'Synthetic matter A2', publication: 'withdrawn', results_version: null },
	{ client_id: 'client-b', case_id: 'case-b1', case_label: 'Synthetic matter B1', publication: 'none', results_version: null },
];
export const GRANTS = [
	{ client_id: 'client-a', subject: 'a-viewer', case_id: 'case-a1', role: 'viewer' },
	{ client_id: 'client-a', subject: 'a-editor', case_id: 'case-a1', role: 'editor' },
	{ client_id: 'client-a', subject: 'a-editor', case_id: 'case-a2', role: 'editor' },
	{ client_id: 'client-b', subject: 'b-editor', case_id: 'case-b1', role: 'editor' },
];
const ORIGINALS = [
	{ client_id: 'client-a', case_id: 'case-a1', asset_id: 'a1-letter', filename: 'a1-letter.pdf', media_type: 'application/pdf', bytes: pdf('Synthetic original A1 letter') },
	{ client_id: 'client-a', case_id: 'case-a1', asset_id: 'a1-note', filename: 'a1-note.txt', media_type: 'text/plain', bytes: new TextEncoder().encode('Synthetic original A1 note.\n') },
	{ client_id: 'client-a', case_id: 'case-a2', asset_id: 'a2-statement', filename: 'a2-statement.pdf', media_type: 'application/pdf', bytes: pdf('Synthetic original A2 statement') },
	{ client_id: 'client-b', case_id: 'case-b1', asset_id: 'b1-letter', filename: 'b1-letter.pdf', media_type: 'application/pdf', bytes: pdf('Synthetic original B1 letter') },
].map((o) => ({ ...o, object_key: `originals/${o.client_id}/${o.case_id}/${o.asset_id}`, size: o.bytes.length, sha256: sha(o.bytes) }));

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_sentinel (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE gate_client (client_id TEXT PRIMARY KEY, issuer TEXT NOT NULL);
CREATE TABLE gate_identity (client_id TEXT NOT NULL REFERENCES gate_client, subject TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('client', 'staff')), label TEXT NOT NULL, PRIMARY KEY (client_id, subject));
CREATE TABLE gate_member (client_id TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (client_id, subject));
CREATE TABLE gate_case (client_id TEXT NOT NULL REFERENCES gate_client, case_id TEXT NOT NULL, case_label TEXT, publication TEXT NOT NULL CHECK (publication IN ('none', 'withdrawn', 'published')), results_version TEXT, PRIMARY KEY (client_id, case_id));
CREATE TABLE gate_grant (client_id TEXT NOT NULL, subject TEXT NOT NULL, case_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')), PRIMARY KEY (client_id, subject, case_id));
CREATE TABLE gate_original (client_id TEXT NOT NULL, case_id TEXT NOT NULL, asset_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL, filename TEXT NOT NULL, PRIMARY KEY (client_id, case_id, asset_id));
CREATE TABLE gate_session (session_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_event (event_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, object_kind TEXT NOT NULL, object_id TEXT NOT NULL, case_id TEXT, version TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed', 'refused')), at TEXT NOT NULL);
`;

/** The fixture as SQL and R2 objects, with its digest (the hosted-gate artifact reports it on /health). */
export function gateFixture() {
	const originals = ORIGINALS.map(({ bytes: _, ...row }) => row);
	const sql = [
		SCHEMA.trim(),
		...rows('gate_client', CLIENTS),
		...rows('gate_identity', IDENTITIES),
		...rows('gate_member', IDENTITIES.map(({ client_id, subject }) => ({ client_id, subject }))),
		...rows('gate_case', CASES),
		...rows('gate_grant', GRANTS),
		...rows('gate_original', originals),
	].join('\n');
	const objects = ORIGINALS.map((o) => ({ key: o.object_key, bytes: o.bytes }));
	return { sql, objects, originals, sha256: sha(JSON.stringify({ profile: 'hosted-gate/1', sql, objects: objects.map((o) => ({ key: o.key, sha256: sha(o.bytes) })) })) };
}

/** The runtime sentinels every hosted run provisions: an R2 object and the D1 row naming its SHA-256. */
export function sentinel(runId: string) {
	const bytes = new TextEncoder().encode(`clearcase runtime sentinel ${runId}\n`);
	return { key: 'runtime/sentinel', bytes, sql: `CREATE TABLE IF NOT EXISTS runtime_sentinel (name TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT OR REPLACE INTO runtime_sentinel (name, value) VALUES ('r2-sha256', ${quote(sha(bytes))});` };
}
