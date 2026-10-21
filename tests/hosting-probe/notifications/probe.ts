// The local legs of the transactional-notification proof (GRS-111). From this directory:
//
//   bun install --frozen-lockfile   # once, online: this workspace's own pins, apart from the root lockfile
//   bun run --bun probe [--out FILE]
//   bun run --bun probe --check FILE
//
// The first form builds src/worker.ts with Bun, serves it on native workerd through `wrangler dev --local` (Node hosts
// Wrangler only) with local D1, R2 and the simulated send_email binding, which saves each message under the dev
// session's temp directory and sends nothing. It drives four configurations of the same Worker from wrangler.toml
// (default, faults, wrong-sender, missing-email), reads every saved message while its server runs, and checks each leg.
// Like GRS-106's runner it re-runs itself inside tests/e2e/pilot/offline.sh (a network namespace with loopback only,
// the host resolver hidden), gives every child an explicit environment allowlist, and refuses (exit 2) a dirty tree,
// Bun other than packageManager's, an installed package that is not its pin, or a Node that is really Bun. It writes
// the summary (default .local/hosting-probe/notifications/summary.json) and exits 0 only when `evidence` is true.
//
// `--check FILE` refuses (exit 1) a summary that is not this runner's PASS for HEAD (summary.ts: one exact shape).
//
// `--adverse NAME|all` runs the same legs against a Worker that sends one thing more than the minimal notice (NAME is
// one of ADVERSE: cc, bcc, reply-to, x-header). The runner's independent check of the saved messages must fail the
// run on it: exit 0 only when it does, 1 when the run passed. It writes no summary and is never evidence.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { linkedNotice, noticeProblems, type NoticeKind } from './src/notice.ts';
import { BOUNDARIES, BUN, checkSummary, HOLD, LEGS, type LegName, MESSAGES, mutationsRefused, pkg, SCHEMA } from './summary.ts';

/** The one Bun API this script uses; the root project has no @types/bun. */
declare const Bun: {
	build(options: { entrypoints: string[]; outdir: string; target: 'browser'; format: 'esm'; define: Record<string, string> }): Promise<{ success: boolean; outputs: { path: string }[]; logs: unknown[] }>;
};

/**
 * Worker variants that send one field more than the minimal notice. Each patches the one call site of `send.send(message)`
 * after the Worker's own check has passed, so only the runner's check of what the binding saved can see the field.
 */
const ADVERSE: Record<string, string> = {
	cc: "{ ...message, cc: 'viewer-a@client-a.example.test' }",
	bcc: "{ ...message, bcc: 'operator-a@client-a.example.test' }",
	'reply-to': "{ ...message, replyTo: 'publisher-b@client-b.example.test' }",
	'x-header': "{ ...message, headers: { 'X-Case': 'Synthetic Matter A1' } }",
};

const HERE = import.meta.dirname;
const PORT = 18911;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://client-a.example.test';
const SENDER = 'notices@notify.client-a.example.test';
const UPLOADER = 'uploader-a@client-a.example.test';
type Leg = { status: 'PASS' | 'FAIL' | 'NOT RUN'; commands: string[]; asserted: string[]; failure?: string };

/** What schema.sql holds that a notice must never carry, per case (title, reference, id, document titles, file names). */
const CASE_STRINGS: Record<string, string[]> = {
	'case-a1': ['Synthetic Matter A1', 'SYN-A1-0001', 'case-a1', 'Synthetic Expert Report', 'a1-report.pdf'],
	'case-a2': ['Synthetic Matter A2', 'SYN-A2-0002', 'case-a2'],
	'case-a3': ['Synthetic Matter A3', 'SYN-A3-0003', 'case-a3', 'Synthetic Witness Statement', 'a3-statement.pdf'],
	'case-a4': ['Synthetic Matter A4', 'SYN-A4-0004', 'case-a4'],
	'case-a5': ['Synthetic Matter A5', 'SYN-A5-0005', 'case-a5'],
	// case-a6's title, "New results", is template wording on purpose: its notice must be refused (content-refused)
	'case-a6': ['SYN-A6-0006', 'case-a6'],
	'case-a7': ['Synthetic Matter A7', 'SYN-A7-0007', 'case-a7'],
	'case-a8': ['Synthetic Matter A8', 'SYN-A8-0008', 'case-a8'],
	'case-b1': ['Synthetic Matter B1', 'SYN-B1-0001', 'case-b1', 'Synthetic Pleading B1', 'b1-pleading.pdf'],
};
const OTHER_ADDRESSES = ['viewer-a@client-a.example.test', 'publisher-a@client-a.example.test', 'operator-a@client-a.example.test', 'uploader-b@client-b.example.test', 'publisher-b@client-b.example.test', 'notify.client-b.example.test'];
const fileFor = (caseId: string, round: number) => `synthetic results file for ${caseId} version ${round}`;

class Refusal extends Error {}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HERE, env: opts.env ?? {}, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function git(...args: string[]): string {
	const r = run('git', args, { env: { PATH: '/usr/bin:/bin' } });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
}
const repo = () => git('rev-parse', '--show-toplevel');
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The first `node` on PATH that is really Node, not Bun's `bun run --bun` stand-in; Wrangler hangs under Bun. */
function realNode(): { path: string; version: string } {
	for (const dir of (process.env.PATH ?? '').split(':')) {
		const candidate = path.join(dir, 'node');
		try {
			accessSync(candidate, constants.X_OK);
		} catch {
			continue;
		}
		const r = run(candidate, ['-p', 'JSON.stringify([process.versions.node, process.versions.bun ?? null])']);
		if (r.code !== 0) continue;
		const [node, bun] = JSON.parse(r.out) as [string, string | null];
		if (bun === null) return { path: candidate, version: node };
	}
	throw new Refusal('no real Node on PATH (Wrangler needs Node >= 22; `node` under `bun run --bun` is Bun)');
}

/** Installed versions must equal the pins: a stale node_modules is not the pinned toolchain. */
function checkInstalled(): Record<string, string> {
	const wrong: string[] = [];
	for (const [name, pin] of Object.entries(pkg.devDependencies)) {
		const file = path.join(HERE, 'node_modules', name, 'package.json');
		const installed = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version : 'missing';
		if (installed !== pin) wrong.push(`${name} ${installed} (pin ${pin})`);
	}
	if (wrong.length) throw new Refusal(`installed packages differ from the pins: ${wrong.join(', ')}; run bun install --frozen-lockfile here`);
	return { ...pkg.devDependencies };
}

/** The network namespace has loopback only and no route off the host; offline.sh checked it, this proves it again. */
function checkOffline(): string {
	const ip = (...args: string[]) => JSON.parse(run('ip', ['-j', ...args], { env: { PATH: '/usr/bin:/bin' } }).out) as { ifname?: string }[];
	const links = ip('addr').map((l) => l.ifname);
	const routes4 = ip('-4', 'route');
	const routes6 = ip('-6', 'route');
	if (links.join() !== 'lo' || routes4.length || routes6.length) throw new Refusal(`not offline: interfaces ${links.join(',')}, ${routes4.length} IPv4 and ${routes6.length} IPv6 routes`);
	return 'own network namespace: interfaces [lo], 0 IPv4 routes, 0 IPv6 routes; host resolver sockets hidden';
}

type Proc = { pid: number; ppid: number; pgrp: number; exe: string };
function processes(): Map<number, Proc> {
	const out = new Map<number, Proc>();
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			let exe = '?';
			try {
				exe = path.basename(readlinkSync(`/proc/${name}/exe`));
			} catch {}
			out.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]), exe });
		} catch {}
	}
	return out;
}

function descendants(root: number): Proc[] {
	const all = processes();
	const ids = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of all.values()) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
	}
	return [...ids].map((id) => all.get(id)).filter((p): p is Proc => p !== undefined);
}

/** One saved message: what the simulator logged, and the text it wrote, read while the server runs. */
type Saved = { env: string; from: string; to: string; subject: string; messageId: string; text: string; html: number; attachments: number; raw: boolean };
type Server = { child: ChildProcess; tree: Proc[]; label: string; log: () => string; saved: Saved[] };
const live = new Set<Server>();
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function startServer(node: string, env: Record<string, string>, persist: string, logs: string, label: string, extra: string[]): Promise<Server> {
	const args = ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', persist, '--show-interactive-dev-session=false', ...extra];
	const child = spawn(node, args, { cwd: HERE, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let text = '';
	const server: Server = { child, tree: [], label, log: () => plain(text), saved: [] };
	live.add(server);
	const out = createWriteStream(path.join(logs, `wrangler-${label}.log`));
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: no "Ready on" within 45 s`)), 45_000);
		const onData = (b: Buffer) => {
			out.write(b);
			text += b.toString();
			if (text.includes('Ready on')) (clearTimeout(timer), resolve());
		};
		child.stdout!.on('data', onData);
		child.stderr!.on('data', onData);
		child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${label}: Wrangler exited ${code} before Ready: ${plain(text).slice(-1500)}`))));
	});
	await ready;
	server.tree = descendants(child.pid!);
	return server;
}

/**
 * Waits until the simulator has logged `count` messages on this server, then reads each new one's files. The binding
 * logs after send() resolves (in waitUntil), so a message can appear just after its response. A message that is not a
 * MessageBuilder send, or an unexpected extra, is kept so the legs can refuse it.
 */
async function savedMessages(server: Server, count: number): Promise<Saved[]> {
	const blocks = () => server.log().split(/\[wrangler:\w+\] send_email binding called with /).slice(1);
	for (const until = Date.now() + 5_000; blocks().length < count && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
	await new Promise((r) => setTimeout(r, 300)); // and no more than count
	for (const block of blocks().slice(server.saved.length)) {
		const lines = block.split('\n');
		const end = lines.findIndex((l, i) => i > 0 && l.startsWith('['));
		const body = (end === -1 ? lines : lines.slice(0, end)).map((l) => l.trimEnd());
		const field = (name: string) => body.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
		const textPath = field('Text');
		server.saved.push({
			env: server.label,
			from: field('From'),
			to: field('To'),
			subject: field('Subject'),
			messageId: textPath ? `<${path.basename(textPath, '.txt')}>` : '',
			text: textPath && existsSync(textPath) ? readFileSync(textPath, 'utf8') : '',
			html: body.filter((l) => l.startsWith('HTML: ')).length,
			attachments: body.filter((l) => l.startsWith('Attachment')).length,
			raw: !lines[0]!.startsWith('MessageBuilder:'),
		});
	}
	return server.saved;
}

/** SIGINT to the server's process group, then SIGTERM and SIGKILL; refuses if any process of its tree survives. */
async function stopServer(server: Server): Promise<void> {
	const { child } = server;
	const pgid = child.pid!;
	const left = () => [...processes().values()].filter((p) => p.pgrp === pgid || server.tree.some((t) => t.pid === p.pid && t.exe === p.exe));
	const gone = () => (child.exitCode !== null || child.signalCode !== null) && left().length === 0;
	for (const [signal, ms] of [['SIGINT', 12_000], ['SIGTERM', 5_000], ['SIGKILL', 5_000]] as const) {
		if (gone()) break;
		try {
			process.kill(-pgid, signal);
		} catch {}
		for (const until = Date.now() + ms; Date.now() < until && !gone(); ) await new Promise((r) => setTimeout(r, 100));
	}
	live.delete(server);
	const survivors = left();
	if (survivors.length) throw new Error(`${server.label}: processes survived the stop: ${survivors.map((p) => `${p.pid} ${p.exe}`).join(', ')}`);
}

async function main(out: string, adverse: string | null): Promise<number> {
	const root = repo();
	const sha = head();
	if (dirty()) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const isolation = checkOffline();
	const node = realNode();
	const pins = checkInstalled();
	rmSync(out, { force: true }); // after every refusal, so a refused run deletes nothing
	const runDir = path.join(root, '.local', 'hosting-probe', 'notifications', new Date().toISOString().replace(/[:.]/g, '-'));
	const rel = (p: string) => p.replace(runDir, '<run>');
	const logs = path.join(runDir, 'logs');
	for (const d of ['home/.config', 'cache', 'logs/wrangler']) mkdirSync(path.join(runDir, d), { recursive: true });
	// GRS-106's allowlist: telemetry, error reports, the banner, the cf.json fetch and dotenv/process-env loading off;
	// a fresh HOME and XDG dirs, so no cached login can be found.
	const env: Record<string, string> = {
		PATH: `${path.dirname(node.path)}:/usr/bin:/bin`,
		HOME: path.join(runDir, 'home'),
		XDG_CONFIG_HOME: path.join(runDir, 'home/.config'),
		XDG_CACHE_HOME: path.join(runDir, 'cache'),
		CI: '1',
		WRANGLER_SEND_METRICS: 'false',
		WRANGLER_SEND_ERROR_REPORTS: 'false',
		WRANGLER_HIDE_BANNER: 'true',
		WRANGLER_LOG_PATH: path.join(runDir, 'logs/wrangler'),
		CLOUDFLARE_CF_FETCH_ENABLED: 'false',
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
		CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
	};
	const persistFor = (label: string) => path.join(runDir, 'persist', label);
	const envArgs = (label: string) => (label === 'default' ? [] : ['--env', label]);
	const d1 = (label: string, ...args: string[]) => {
		const r = run(node.path, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', ...envArgs(label), '--persist-to', persistFor(label), ...args], { env });
		writeFileSync(path.join(logs, `wrangler-d1-${label}-${Date.now()}.log`), r.out);
		return r;
	};
	const d1Cmd = (label: string, what: string) => `node node_modules/wrangler/bin/wrangler.js d1 execute DB --local${envArgs(label).map((a) => ` ${a}`).join('')} --persist-to ${rel(persistFor(label))} ${what}`;
	const serveCmd = (label: string) => `node node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port ${PORT} --inspector-ip 127.0.0.1 --inspector-port 0 --persist-to ${rel(persistFor(label))} --show-interactive-dev-session=false${envArgs(label).map((a) => ` ${a}`).join('')}`;
	const serve = (label: string) => startServer(node.path, env, persistFor(label), logs, label, envArgs(label));

	// Synthetic canaries on every request, as a session's Authorization header and cookie would be: none may surface.
	const canaries = [`canary-auth-${randomUUID()}`, `canary-cookie-${randomUUID()}`];
	const opsSeen: string[] = [];
	/** Every messageId the app reported in any response: what it saw come back from send(). */
	const appIds = new Set<string>();
	async function http(method: string, pathname: string, as?: string, body?: unknown) {
		const headers: Record<string, string> = { authorization: `Bearer ${canaries[0]}`, cookie: `__session=${canaries[1]}` };
		if (as) headers['x-probe-identity'] = as;
		if (body !== undefined) headers['content-type'] = 'application/json';
		const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20_000) });
		const text = await res.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {}
		if (pathname.startsWith('/ops/')) opsSeen.push(text);
		for (const n of [json?.notice, ...(json?.notifications ?? [])]) for (const id of n?.messageIds ?? []) appIds.add(id);
		return { status: res.status, location: res.headers.get('location'), text, json };
	}
	const A = (user: string) => `client-a/${user}`;
	const publish = (caseId: string, round = 1, file = fileFor(caseId, round), as = A('a-publisher')) => http('POST', `/cases/${caseId}/publish`, as, { round, file });
	const sweep = (at: number) => http('GET', `/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*&time=${at}&format=json`);
	const ops = async () => ((await http('GET', '/ops/notifications', A('a-operator'))).json?.notifications ?? []) as any[];
	const opsRow = async (caseId: string) => (await ops()).find((n) => n.caseId === caseId);
	/** The case as its uploader sees it in the app, and its version-1 file bytes. */
	async function intact(caseId: string, as = A('a-uploader')) {
		const c = (await http('GET', `/cases/${caseId}`, as)).json;
		const file = await http('GET', `/cases/${caseId}/file?version=1`, as);
		return { publications: c?.publications ?? [], notices: c?.notices ?? [], file: file.status === 200 ? file.text : null };
	}
	const published = (s: Awaited<ReturnType<typeof intact>>, caseId: string) =>
		s.publications.length === 1 && s.publications[0].version === 1 && s.publications[0].file_sha256 === sha256(fileFor(caseId, 1)) && s.file === fileFor(caseId, 1) && s.notices.length === 1 && s.notices[0].kind === 'publication';
	const history = (row: any) => (row?.history ?? []).map((h: any) => `${h.n}:${h.outcome}:${h.code}`).join(' ');
	const noticeCase = new Map<string, { caseId: string; kind: NoticeKind }>();
	const remember = <T extends { json: any }>(r: T, caseId: string, kind: NoticeKind): T => (r.json?.noticeId && noticeCase.set(r.json.noticeId, { caseId, kind }), r);

	const legs = Object.fromEntries(LEGS.map((n) => [n, { status: 'NOT RUN', commands: [], asserted: [] } as Leg])) as Record<LegName, Leg>;
	async function leg(name: LegName, commands: string[], body: (check: (ok: boolean, what: string) => void) => Promise<void>) {
		const l: Leg = { status: 'FAIL', commands, asserted: [] };
		legs[name] = l;
		try {
			await body((ok, what) => {
				if (!ok) throw new Error(`assertion failed: ${what}`);
				l.asserted.push(what);
			});
			l.status = 'PASS';
		} catch (e) {
			l.failure = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	const startedAt = new Date().toISOString();
	let servedRevision: string | null = null;
	let workerd: string | null = null;
	let artifact: string | null = null;
	const allSaved: Saved[] = [];
	const serverLogs: string[] = [];
	let failure: string | null = null;
	let server: Server | null = null;
	const stop = async () => {
		if (!server) return;
		await savedMessages(server, 0); // any message no leg asked for still counts in no-leak
		serverLogs.push(server.log());
		allSaved.push(...server.saved);
		await stopServer(server);
		server = null;
	};
	try {
		await leg('build', ['Bun.build src/worker.ts -> build/worker.js (PROBE_SOURCE_REVISION=HEAD)'], async (check) => {
			rmSync(path.join(HERE, 'build'), { recursive: true, force: true });
			let entry = path.join(HERE, 'src/worker.ts');
			if (adverse !== null) {
				const source = readFileSync(entry, 'utf8');
				if (source.split('send.send(message)').length !== 2) throw new Refusal('the Worker has not exactly one send.send(message) call site to patch');
				mkdirSync(path.join(HERE, 'build/adverse'), { recursive: true });
				entry = path.join(HERE, 'build/adverse/worker.ts');
				writeFileSync(entry, source.replace('send.send(message)', `send.send(${ADVERSE[adverse]})`).replaceAll("'./", "'../../src/"));
			}
			const r = await Bun.build({ entrypoints: [entry], outdir: path.join(HERE, 'build'), target: 'browser', format: 'esm', define: { PROBE_SOURCE_REVISION: JSON.stringify(sha) } });
			check(r.success && process.versions.bun === BUN, `Bun ${BUN} builds the Worker, offline`);
			check(r.outputs.length === 1 && r.outputs[0]!.path === path.join(HERE, 'build/worker.js'), 'the build writes one module, build/worker.js');
			const bundle = readFileSync(path.join(HERE, 'build/worker.js'), 'utf8');
			check(!/^\s*import\b/m.test(bundle) && bundle.includes(JSON.stringify(sha)), 'the module imports nothing (Wrangler serves it as built, no_bundle) and carries the HEAD stamp');
			artifact = `sha256:${sha256(bundle)}`;
			check(true, 'the module digest is recorded (artifact)');
		});

		await leg('binding-config', [d1Cmd('default', '--file schema.sql'), serveCmd('default')], async (check) => {
			check(d1('default', '--file', 'schema.sql').code === 0, 'wrangler d1 execute --local applies schema.sql (synthetic clients A and B), exit 0');
			server = await serve('default');
			const host = server.tree.find((p) => p.pid === server!.child.pid);
			check(!!host && host.exe.startsWith('node') && server.tree.some((p) => p.exe === 'workerd'), `Wrangler (${host?.exe}) prints Ready and a native workerd descendant serves the Worker`);
			workerd = pins.workerd!;
			const log = server.log();
			check(/env\.EMAIL \(unrestricted - senders: notices@notify\.client-a\.example\.test\)\s+Send Email\s+local/.test(log), "Wrangler lists env.EMAIL as a local Send Email binding restricted to client A's sender (allowed_sender_addresses)");
			check(/env\.DB \(notifications-probe-local-only\)\s+D1 Database\s+local/.test(log) && /env\.BUCKET \(notifications-probe-local-only\)\s+R2 Bucket\s+local/.test(log), 'D1 and R2 are local bindings');
			check(!/remote/i.test(log.slice(0, log.indexOf('Ready on'))), 'no binding is remote');
			const health = (await http('GET', '/health')).json;
			check(health?.client === 'client-a' && health.DB === true && health.BUCKET === true && health.EMAIL === true, "GET /health: client A's instance sees DB, BUCKET and EMAIL.send");
			servedRevision = health?.revision ?? null;
			check(servedRevision === sha, 'GET /health reports the HEAD stamp of the build');
		});

		await leg('publication-notice', ['POST /cases/case-a1/publish round=1 (a-publisher)'], async (check) => {
			const r = remember(await publish('case-a1'), 'case-a1', 'publication');
			check(r.status === 200 && r.json.published === true && r.json.created === true && r.json.fileSha256 === sha256(fileFor('case-a1', 1)), 'the publication answers 200 with the stored file digest');
			const n = r.json.notice;
			check(n.state === 'accepted' && n.attempts === 1 && n.acceptance === 'accepted' && n.messageIds.length === 1, 'the notice was sent once and the simulated binding accepted it (a messageId came back)');
			check(/^not observed/.test(n.delivery) && /^not observed/.test(n.inbox), 'delivery and inbox arrival are reported apart from acceptance, as not observed');
			const saved = await savedMessages(server!, 1);
			check(saved.length === 1 && saved[0]!.messageId === n.messageIds[0] && !saved[0]!.raw, 'the simulator saved exactly one message, the one whose messageId the app recorded');
			const m = saved[0]!;
			check(m.from === SENDER && m.to === UPLOADER && m.subject === 'ClearCase: new results are ready', "it is from client A's sender to the uploader alone, with the generic publication subject");
			check(noticeProblems({ from: m.from, to: m.to, subject: m.subject, text: m.text }, { kind: 'publication', origin: ORIGIN, sender: SENDER, recipient: UPLOADER, forbidden: CASE_STRINGS['case-a1']! }).length === 0, 'the saved message passes the content check: the publication template around one link, no case title, document title, file name or reference');
			check(m.html === 0 && m.attachments === 0, 'no HTML part and no attachment was saved');
			check(linkedNotice(m.text, ORIGIN) === r.json.noticeId, "its only link is client A's origin /n/<the notice id>, with no query or token");
		});

		await leg('input-needed-notice', ['POST /cases/case-a1/input-needed round=1 (a-publisher)'], async (check) => {
			const r = remember(await http('POST', '/cases/case-a1/input-needed', A('a-publisher'), { round: 1 }), 'case-a1', 'input-needed');
			check(r.status === 200 && r.json.created === true && r.json.notice.state === 'accepted' && r.json.notice.attempts === 1, 'the input-needed event answers 200 and its notice was sent once');
			const m = (await savedMessages(server!, 2))[1];
			check(!!m && m.messageId === r.json.notice.messageIds[0], 'the simulator saved one more message, the one the app recorded');
			check(!!m && noticeProblems({ from: m.from, to: m.to, subject: m.subject, text: m.text }, { kind: 'input-needed', origin: ORIGIN, sender: SENDER, recipient: UPLOADER, forbidden: CASE_STRINGS['case-a1']! }).length === 0, 'it passes the content check as the input-needed template');
			check(!!m && linkedNotice(m.text, ORIGIN) === r.json.noticeId && r.json.noticeId !== [...noticeCase.keys()][0], 'it links its own notice, not the publication notice');
		});

		await leg('authenticated-link', ['GET /n/<id> (no identity)', 'GET /n/<id> (client-b/b-uploader)', 'GET /n/<id> (client-a/a-viewer)', 'GET /n/<id> (client-a/a-uploader)', 'GET /cases/case-a1 and /cases/case-a1/file?version=1 (a-uploader)'], async (check) => {
			const [pub, inp] = [...noticeCase.keys()];
			const anon = await http('GET', `/n/${pub}`);
			check(anon.status === 401 && anon.location === null, 'the link alone is refused: 401 sign in, no redirect');
			const b = await http('GET', `/n/${pub}`, 'client-b/b-uploader');
			check(b.status === 401, "client B's session is no session on client A's instance: 401");
			const v = await http('GET', `/n/${pub}`, A('a-viewer'));
			check(v.status === 404 && !v.text.includes('case-a1'), "another user of client A gets 404, with nothing about the notice's case");
			const u = await http('GET', `/n/${pub}`, A('a-uploader'));
			const u2 = await http('GET', `/n/${inp}`, A('a-uploader'));
			check(u.status === 303 && u.location === '/cases/case-a1' && u2.status === 303 && u2.location === '/cases/case-a1', 'the signed-in uploader is sent to the case, inside the app, for both notices');
			const s = await intact('case-a1');
			check(s.publications.length === 1 && s.file === fileFor('case-a1', 1), 'the uploader sees the publication and reads its file byte for byte');
			check(s.notices.map((n: any) => n.id).sort().join() === [pub, inp].sort().join(), 'the in-app notices are the two the emails link to');
		});

		await leg('app-deduplication', ['POST /cases/case-a1/publish round=1 (again, same file)', 'POST /cases/case-a1/publish round=1 (other file)', 'two concurrent POST /cases/case-a8/publish round=1, with two different files'], async (check) => {
			const again = await publish('case-a1');
			check(again.status === 200 && again.json.created === false && again.json.noticeId === [...noticeCase.keys()][0] && again.json.notice.attempts === 1, 'publishing the same version again returns the same notice, not a second one, and sends nothing more');
			const other = await publish('case-a1', 1, 'synthetic other content');
			check(other.status === 409, 'the same version with other content answers 409');
			check((await savedMessages(server!, 2)).length === 2, 'the simulator saved no further message');
			const s = await intact('case-a1');
			check(s.file === fileFor('case-a1', 1) && s.publications.length === 1 && s.notices.length === 2, 'the file, the publication and the in-app notices are unchanged');
			const files = ['synthetic racing file one', 'synthetic racing file two'];
			const raced = await Promise.all(files.map((f) => publish('case-a8', 1, f)));
			const won = raced.findIndex((r) => r.status === 200);
			if (won >= 0) remember(raced[won]!, 'case-a8', 'publication');
			const a8 = await intact('case-a8');
			check(raced.map((r) => r.status).sort().join() === '200,409' && a8.publications.length === 1 && a8.publications[0].file_sha256 === sha256(files[won]!) && a8.file === files[won] && a8.notices.length === 1 && (await savedMessages(server!, 3)).length === 3, 'of two concurrent publishes of one version with different files, one answers 200 and one 409; the file served is the one the publication names, with one in-app notice and one email');
		});

		await leg('wrong-client', ['POST /cases/case-b1/publish (client-a/a-publisher)', 'POST /cases/case-a1/publish round=2 (client-b/b-publisher)', 'GET /cases/case-b1 (client-a/a-publisher)', 'GET /ops/notifications (client-b/b-publisher)'], async (check) => {
			const crossed = await publish('case-b1');
			check(crossed.status === 404, "client B's case is not found through client A's instance, though its row is in the same store: 404");
			const b = await publish('case-a1', 2, fileFor('case-a1', 2), 'client-b/b-publisher');
			const bc = await http('GET', '/cases/case-b1', A('a-publisher'));
			const bo = await http('GET', '/ops/notifications', 'client-b/b-publisher');
			check(b.status === 401 && bo.status === 401 && bc.status === 404, "client B's publisher gets 401 on A's publish and operator routes; A's publisher gets 404 for B's case");
			check((await savedMessages(server!, 3)).length === 3, 'no message was saved for any crossed request');
			const s = await intact('case-a1');
			check(s.publications.length === 1 && s.notices.length === 2, "client A's case has no round-2 publication or notice");
		});

		await leg('content-refused', ['POST /cases/case-a6/publish (title "New results")', 'GET /cases/case-a6 and its file (a-uploader)'], async (check) => {
			const r = await publish('case-a6');
			check(r.status === 200 && r.json.published === true && r.json.notice.state === 'failed' && history(r.json.notice) === '1:permanent:NOTICE_CONTENT_REFUSED', "the Worker's own content check refuses the notice (its body would carry the case title) and does not retry; the publication answers 200");
			check((await savedMessages(server!, 3)).length === 3, 'nothing was sent');
			check(published(await intact('case-a6'), 'case-a6'), 'the publication, its file and the in-app notice are intact');
		});

		await leg('recipient-missing', ['POST /cases/case-a5/publish (uploader has no address)', 'GET /cases/case-a5 and its file (publisher)'], async (check) => {
			const r = await publish('case-a5');
			check(r.status === 200 && r.json.notice.state === 'failed' && history(r.json.notice) === '1:permanent:RECIPIENT_MISSING', 'an uploader with no address fails closed: RECIPIENT_MISSING, no retry, publication 200');
			check((await savedMessages(server!, 3)).length === 3, 'nothing was sent');
			check(published(await intact('case-a5', A('a-publisher')), 'case-a5'), 'the publication, its file and the in-app notice are intact');
			await stop();
		});

		const T0 = Date.now();
		const seeded = randomUUID();
		await leg('interrupted-send', [d1Cmd('faults', '--file schema.sql'), d1Cmd('faults', '--command "<a case-a8 notice whose attempt 1 is still sending, claimed 1 h ago>"'), serveCmd('faults'), 'scheduled sweep at +1 min', 'scheduled sweep at +7 min'], async (check) => {
			check(d1('faults', '--file', 'schema.sql').code === 0, 'schema.sql applied to the faults state');
			const claimed = T0 - 3_600_000;
			const seed = d1('faults', '--command', `INSERT INTO notices (id, client, case_id, kind, round, recipient, created_at) VALUES ('${seeded}', 'client-a', 'case-a8', 'input-needed', 1, 'a-uploader', '${new Date(claimed).toISOString()}'); INSERT INTO outbox (notice_id, state, attempts, next_at, claimed_at, updated_at) VALUES ('${seeded}', 'sending', 1, NULL, ${claimed}, ${claimed})`);
			noticeCase.set(seeded, { caseId: 'case-a8', kind: 'input-needed' });
			server = await serve('faults');
			const first = await sweep(T0 + 60_000);
			const row = await opsRow('case-a8');
			check(seed.code === 0 && first.json?.outcome === 'ok' && row?.state === 'retrying' && history(row) === '1:ambiguous:INTERRUPTED' && row.acceptance === 'unknown', 'an attempt left "sending" by a Worker cut off mid-send is settled by the next sweep as ambiguous (INTERRUPTED), and retried');
			await sweep(T0 + 7 * 60_000);
			const done = await opsRow('case-a8');
			const saved = await savedMessages(server!, 1);
			check(done?.state === 'accepted' && history(done) === '1:ambiguous:INTERRUPTED 2:accepted:null' && done.possibleDuplicate === true, 'the retry is accepted, and the notice is marked a possible duplicate, since attempt 1 may have sent');
			check(saved.length === 1 && saved[0]!.messageId === done.messageIds[0] && linkedNotice(saved[0]!.text, ORIGIN) === seeded, 'one message was saved, linking the seeded notice');
		});

		const T1 = Date.now();
		await leg('retry-bounded', ['POST /cases/case-a2/publish (faults: E_RATE_LIMIT_EXCEEDED x3)', 'scheduled sweep at +1 min', 'scheduled sweep at +6 min', 'scheduled sweep at +40 min', 'scheduled sweep at +120 min', 'GET /cases/case-a2 and its file (a-uploader)'], async (check) => {
			const r = remember(await publish('case-a2'), 'case-a2', 'publication');
			const n = r.json?.notice;
			check(r.status === 200 && r.json.published === true && n.state === 'retrying' && history(n) === '1:transient:E_RATE_LIMIT_EXCEEDED' && Date.parse(n.nextAttemptAt) - Date.parse(n.history[0].at) === 5 * 60_000, 'attempt 1 is refused as transient; the publication answers 200 and attempt 2 is due 5 min later');
			await sweep(T1 + 60_000);
			check((await opsRow('case-a2'))?.attempts === 1, 'a sweep before the attempt is due sends nothing');
			await sweep(T1 + 6 * 60_000);
			const two = await opsRow('case-a2');
			check(two?.state === 'retrying' && two.attempts === 2 && Date.parse(two.nextAttemptAt) === T1 + 36 * 60_000, 'the sweep at +6 min makes attempt 2; attempt 3 is due 30 min later');
			await sweep(T1 + 40 * 60_000);
			const three = await opsRow('case-a2');
			check(three?.state === 'failed' && three.attempts === 3 && three.acceptance === 'refused' && three.possibleDuplicate === false && three.nextAttemptAt === null, 'attempt 3 fails it: state failed, acceptance refused, no possible duplicate, nothing more due');
			await sweep(T1 + 120 * 60_000);
			check((await opsRow('case-a2'))?.attempts === 3, 'retry is bounded: a later sweep makes no fourth attempt (MAX_ATTEMPTS 3)');
			check((await savedMessages(server!, 1)).filter((m) => linkedNotice(m.text, ORIGIN) === r.json.noticeId).length === 0, 'no message was saved for case-a2');
			check(published(await intact('case-a2'), 'case-a2'), 'the publication, its file and the in-app notice are intact after three failed sends');
		});

		const T2 = Date.now();
		await leg('ambiguous-duplicate', ['POST /cases/case-a3/publish (faults: accepted, then E_INTERNAL_SERVER_ERROR; then pass)', 'POST /cases/case-a4/publish (faults: no answer within 1.5 s; then pass)', 'scheduled sweep at +6 min', 'GET /ops/notifications (a-operator)', 'GET /cases/case-a3 (a-uploader)'], async (check) => {
			const a3 = remember(await publish('case-a3'), 'case-a3', 'publication');
			const after3 = await savedMessages(server!, 2);
			check(a3.json?.published === true && a3.json.notice.state === 'retrying' && history(a3.json.notice) === '1:ambiguous:E_INTERNAL_SERVER_ERROR' && after3.length === 2 && !a3.json.notice.messageIds.includes(after3[1]!.messageId), 'case-a3: the binding saved the message, but the Worker saw E_INTERNAL_SERVER_ERROR; the attempt is ambiguous and the app holds no messageId for it');
			const a4 = remember(await publish('case-a4'), 'case-a4', 'publication');
			check(a4.json?.published === true && history(a4.json.notice) === '1:ambiguous:TIMEOUT' && (await savedMessages(server!, 2)).length === 2, 'case-a4: a send with no answer within the timeout is ambiguous too; nothing was saved');
			await sweep(T2 + 6 * 60_000);
			const rows = await ops();
			const r3 = rows.find((n) => n.caseId === 'case-a3');
			const r4 = rows.find((n) => n.caseId === 'case-a4');
			check(r3?.state === 'accepted' && history(r3) === '1:ambiguous:E_INTERNAL_SERVER_ERROR 2:accepted:null' && r4?.state === 'accepted' && history(r4) === '1:ambiguous:TIMEOUT 2:accepted:null', 'the sweep retries both, and both are accepted');
			const saved = (await savedMessages(server!, 4)).filter((m) => linkedNotice(m.text, ORIGIN) === a3.json.noticeId);
			check(saved.length === 2 && saved[0]!.text === saved[1]!.text && saved[0]!.subject === saved[1]!.subject && saved[0]!.messageId !== saved[1]!.messageId, 'case-a3 has two saved messages: the same generic notice and link, two provider messageIds (a real duplicate)');
			check(r3.possibleDuplicate === true && r3.acceptance === 'accepted' && r3.messageIds.length === 1 && r3.messageIds[0] === saved[1]!.messageId && r4.possibleDuplicate === true, 'the operator view marks both possible duplicates; it knows only the messageId the app saw');
			check((await intact('case-a3')).notices.length === 1, 'the uploader has one in-app notice for case-a3, not two');
			check(saved.every((m) => noticeProblems({ from: m.from, to: m.to, subject: m.subject, text: m.text }, { kind: 'publication', origin: ORIGIN, sender: SENDER, recipient: UPLOADER, forbidden: CASE_STRINGS['case-a3']! }).length === 0), 'both copies pass the content check');
		});

		const T3 = Date.now();
		await leg('permanent-no-retry', ['POST /cases/case-a7/publish (faults: E_RECIPIENT_SUPPRESSED)', 'scheduled sweep at +120 min'], async (check) => {
			const r = remember(await publish('case-a7'), 'case-a7', 'publication');
			check(r.json?.published === true && r.json.notice.state === 'failed' && history(r.json.notice) === '1:permanent:E_RECIPIENT_SUPPRESSED', 'a suppressed recipient is permanent: failed after one attempt, publication 200');
			await sweep(T3 + 120 * 60_000);
			check((await opsRow('case-a7'))?.attempts === 1, 'no sweep retries it');
			check(published(await intact('case-a7'), 'case-a7') && (await savedMessages(server!, 4)).length === 4, 'the publication, its file and the in-app notice are intact; nothing was saved');
		});

		await leg('operator-visibility', ['GET /ops/notifications (client-a/a-viewer)', 'GET /ops/notifications (client-a/a-operator)'], async (check) => {
			check((await http('GET', '/ops/notifications', A('a-viewer'))).status === 403, 'a client user who is not an operator gets 403');
			const rows = await ops();
			check(rows.map((n) => n.caseId).join() === 'case-a8,case-a2,case-a3,case-a4,case-a7' && rows.every((n) => n.maxAttempts === 3 && Array.isArray(n.history) && n.history.length === n.attempts), 'the operator sees every notice of this instance, each with its attempts, bound and per-attempt outcome and code');
			check(rows.filter((n) => n.state === 'failed').map((n) => `${n.caseId}:${n.acceptance}`).join() === 'case-a2:refused,case-a7:refused' && rows.filter((n) => n.possibleDuplicate).map((n) => n.caseId).join() === 'case-a8,case-a3,case-a4', 'failed notices and possible duplicates are listed, not hidden');
			const text = opsSeen.join('\n');
			check(rows.every((n) => /^not observed/.test(n.delivery) && /^not observed/.test(n.inbox)) && !text.includes('@client-a.example.test') && !Object.values(CASE_STRINGS).flat().some((f) => !f.startsWith('case-') && text.includes(f)), 'the view keeps acceptance apart from delivery and inbox, and carries no address, case title, document title, file name or reference');
			await stop();
		});

		await leg('sender-restriction', [d1Cmd('wrong-sender', '--file schema.sql'), serveCmd('wrong-sender'), 'POST /cases/case-a1/publish (SENDER is client B\'s address)', 'GET /cases/case-a1 and its file (a-uploader)'], async (check) => {
			check(d1('wrong-sender', '--file', 'schema.sql').code === 0, 'schema.sql applied to the wrong-sender state');
			server = await serve('wrong-sender');
			check(/env\.EMAIL \(unrestricted - senders: notices@notify\.client-a\.example\.test\)/.test(server.log()), "the binding is still restricted to client A's sender");
			const r = await publish('case-a1');
			check(r.json?.published === true && r.json.notice.state === 'failed' && history(r.json.notice) === '1:permanent:LOCAL_SENDER_NOT_ALLOWED', "the local binding refuses a send from client B's address (allowed_sender_addresses); permanent, no retry, publication 200");
			check((await savedMessages(server!, 0)).length === 0 && !server.log().includes('send_email binding called'), 'nothing was saved');
			check(published(await intact('case-a1'), 'case-a1'), 'the publication, its file and the in-app notice are intact');
			await stop();
		});

		await leg('binding-missing', [d1Cmd('missing-email', '--file schema.sql'), serveCmd('missing-email'), 'POST /cases/case-a1/publish', 'GET /cases/case-a1 and its file (a-uploader)'], async (check) => {
			check(d1('missing-email', '--file', 'schema.sql').code === 0, 'schema.sql applied to the missing-email state');
			server = await serve('missing-email');
			const health = (await http('GET', '/health')).json;
			check(!server.log().includes('env.EMAIL') && health?.EMAIL === false && health.DB === true && health.BUCKET === true, 'the same Worker without its send_email binding starts; /health reports EMAIL absent');
			const r = await publish('case-a1');
			check(r.json?.published === true && r.json.notice.state === 'failed' && history(r.json.notice) === '1:permanent:EMAIL_BINDING_MISSING', 'publishing answers 200; the notice fails closed as EMAIL_BINDING_MISSING, visible to the operator');
			check((await savedMessages(server!, 0)).length === 0, 'nothing was saved');
			check(published(await intact('case-a1'), 'case-a1'), 'the publication, its file and the in-app notice are intact');
			await stop();
		});

		await leg('no-leak', ['scan of every saved message, Wrangler log and operator response of the run'], async (check) => {
			check(allSaved.map((m) => `${m.env}/${noticeCase.get(linkedNotice(m.text, ORIGIN) ?? '')?.caseId}/${noticeCase.get(linkedNotice(m.text, ORIGIN) ?? '')?.kind}`).join() === MESSAGES.map((m) => m.join('/')).join() && allSaved.every((m) => !m.raw && m.html === 0 && m.attachments === 0), 'the run saved exactly the seven expected messages, all MessageBuilder sends with a text part only');
			check(allSaved.every((m) => { const c = noticeCase.get(linkedNotice(m.text, ORIGIN) ?? '')!; return noticeProblems({ from: m.from, to: m.to, subject: m.subject, text: m.text }, { kind: c.kind, origin: ORIGIN, sender: SENDER, recipient: UPLOADER, forbidden: CASE_STRINGS[c.caseId]! }).length === 0; }), "every saved message passes the content check for its own case's strings");
			const everything = [...Object.values(CASE_STRINGS).flat(), ...OTHER_ADDRESSES, ...Object.keys(CASE_STRINGS).flatMap((c) => [fileFor(c, 1), fileFor(c, 2)]), 'synthetic other content', 'synthetic racing file'];
			check(allSaved.every((m) => !everything.some((f) => `${m.from}\n${m.to}\n${m.subject}\n${m.text}`.toLowerCase().includes(f.toLowerCase()))), "no saved message carries any case's title, reference, id, document title, file name or file text, or any address but the uploader's");
			const surfaces = [...allSaved.map((m) => m.text), ...serverLogs, ...opsSeen].join('\n');
			check(!canaries.some((c) => surfaces.includes(c)), 'the Authorization and cookie canaries sent on every request appear in no saved message, Wrangler log or operator response');
		});
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	} finally {
		if (server) await stop().catch((e: unknown) => (failure ??= String(e)));
		for (const s of [...live]) await stopServer(s).catch((e: unknown) => (failure ??= String(e)));
	}

	if (adverse !== null) {
		const caught = failure !== null && failure.includes('assertion failed');
		console.log(caught ? `ADVERSE PASS ${adverse}: the run refused it (${failure})` : `ADVERSE FAIL ${adverse}: the run ${failure === null ? 'passed' : `failed for another reason (${failure})`} with the field sent`);
		return caught ? 0 : 1;
	}
	const endSha = head();
	const clean = !dirty();
	// One entry per saved message, all measured but the two HOLD states, which no local run can observe.
	const messages = allSaved.map((m) => {
		const c = noticeCase.get(linkedNotice(m.text, ORIGIN) ?? '');
		const ok = !!c && noticeProblems({ from: m.from, to: m.to, subject: m.subject, text: m.text }, { kind: c.kind, origin: ORIGIN, sender: SENDER, recipient: UPLOADER, forbidden: CASE_STRINGS[c.caseId]! }).length === 0;
		return { env: m.env, caseId: c?.caseId ?? null, kind: c?.kind ?? null, text: `sha256:${sha256(m.text)}`, contentCheck: ok ? 'PASS' : 'FAIL', appSaw: appIds.has(m.messageId) ? 'accepted' : 'not seen: the attempt ended ambiguous', providerAcceptance: 'simulated: saved by the local binding', delivery: 'HOLD: M3', inboxArrival: 'HOLD: M3' };
	});
	const summary: Record<string, unknown> = {
		schema: SCHEMA,
		sourceSha: sha,
		treeClean: clean && endSha === sha,
		servedRevision,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: process.versions.bun, node: node.version, workerd, build: `Bun ${BUN}`, runner: `Bun ${BUN}`, wrangler: `Node ${node.version}`, app: `workerd ${workerd} (native)` },
		pins,
		artifact,
		isolation: { network: isolation, env: Object.keys(env).sort() },
		boundaries: { ...BOUNDARIES },
		legs,
		messages,
		hold: HOLD,
		failure,
		evidence: false,
	};
	const draft = { ...summary, evidence: true, checker: { mutationsRefused: 1, accepted: null } };
	if (failure === null && clean && endSha === sha) {
		const problems = checkSummary(draft, sha);
		if (problems.length === 0) {
			const m = mutationsRefused(draft, sha);
			summary.checker = { mutationsRefused: m.refused, accepted: m.accepted };
			summary.evidence = m.accepted === null && checkSummary({ ...summary, evidence: true }, sha).length === 0;
		} else for (const p of problems) console.log(`refused: ${p}`);
	}
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	for (const name of LEGS) console.log(`${legs[name].status.padEnd(7)} ${name}${legs[name].failure ? `: ${legs[name].failure}` : ''}`);
	if (!clean || endSha !== sha) console.log(`FAIL    tree changed during the run (HEAD ${endSha.slice(0, 12)}, clean ${clean})`);
	console.log(`${summary.evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} evidence: ${summary.evidence} summary: ${path.relative(root, out)}`);
	return summary.evidence ? 0 : 1;
}

/** Re-runs this file inside tests/e2e/pilot/offline.sh: no network but loopback, the host resolver hidden. */
function enterOffline(args: string[]): number {
	const node = realNode();
	const offline = path.join(repo(), 'tests/e2e/pilot/offline.sh');
	const ids = (flag: string) => run('id', [flag], { env: { PATH: '/usr/bin:/bin' } }).out.trim();
	const r = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${ids('-u')}`, `OUTER_GID=${ids('-g')}`, offline, process.execPath, import.meta.filename, '--inside', ...args], {
		cwd: HERE,
		stdio: 'inherit',
		env: { PATH: `${path.dirname(node.path)}:/usr/bin:/bin` },
	});
	return r.status ?? 1;
}

const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'string' }, adverse: { type: 'string' }, inside: { type: 'boolean' } } });
try {
	if (process.versions.bun !== BUN) throw new Refusal(`runs under Bun ${BUN} only (packageManager); this is ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}`);
	if (values.check) {
		const problems = checkSummary(JSON.parse(readFileSync(values.check, 'utf8')), head());
		for (const p of problems) console.log(`refused: ${p}`);
		console.log(problems.length ? `CHECK FAIL ${values.check}` : `CHECK PASS ${values.check}`);
		process.exit(problems.length ? 1 : 0);
	}
	const names = values.adverse === 'all' ? Object.keys(ADVERSE) : values.adverse === undefined ? [] : [values.adverse];
	for (const name of names) if (!(name in ADVERSE)) throw new Refusal(`--adverse ${name}: not one of ${Object.keys(ADVERSE).join(', ')}, all`);
	if (names.length > 1) {
		const results = names.map((name) => enterOffline(['--adverse', name]));
		console.log(results.every((r) => r === 0) ? 'ADVERSE ALL PASS' : `ADVERSE ALL FAIL: ${names.filter((_, i) => results[i] !== 0).join(', ')}`);
		process.exit(results.every((r) => r === 0) ? 0 : 1);
	}
	const out = path.resolve(values.out ?? path.join(repo(), '.local/hosting-probe/notifications/summary.json'));
	if (!values.inside) process.exit(enterOffline(names.length ? ['--adverse', names[0]!] : ['--out', out]));
	if (process.env.CLEARCASE_OFFLINE !== '1') throw new Refusal('--inside runs only under tests/e2e/pilot/offline.sh');
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void Promise.allSettled([...live].map(stopServer)).then(() => process.exit(130)));
	process.exit(await main(out, names[0] ?? null));
} catch (e) {
	if (!(e instanceof Refusal)) throw e;
	console.error(`PROBE REFUSED: ${e.message}`);
	process.exit(2);
}
