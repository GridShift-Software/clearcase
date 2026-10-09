// Minimal Chrome DevTools Protocol driver over the global WebSocket (ported from the hardened pilot prototype).
// Browser-level auto-attach, so popups, out-of-process frames (the sandboxed pdf.js frame) and workers are observed
// from their first instruction: dialogs, requests, downloads, titles and console output.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Chromium: $CLEARCASE_CHROMIUM, else the Playwright build GRS-10's tests use. */
export const CHROME = process.env.CLEARCASE_CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;
export const chromeAvailable = () => existsSync(CHROME);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CANARY_PORT = +(process.env.CANARY_PORT ?? 41199);

/** Launch a headless Chromium with its own profile under `profileRoot`; every non-loopback host maps to the canary. */
/** Browser PIDs this process started; killed on exit (PID-owned teardown). */
const b_pids = new Set();
process.on('exit', () => { for (const p of b_pids) try { process.kill(p, 'SIGKILL'); } catch {} });

export async function launch({ profileRoot, extra = [] }) {
	if (!chromeAvailable()) throw new Error(`Chromium not found at ${CHROME} (set CLEARCASE_CHROMIUM)`);
	mkdirSync(profileRoot, { recursive: true });
	const dir = mkdtempSync(join(profileRoot, 'chrome-'));
	const dl = join(dir, 'downloads');
	mkdirSync(dl);
	const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
		'--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
		'--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
		'--disable-domain-reliability', '--metrics-recording-only', '--no-pings', '--window-size=1400,900',
		// Any non-loopback hostname resolves to the canary, so exfiltration attempts are observable (and never leave the box).
		`--host-resolver-rules=MAP * 127.0.0.1:${CANARY_PORT}, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
		...extra, 'about:blank'];
	const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
	b_pids.add(proc.pid);
	const wsUrl = await new Promise((res, rej) => {
		let buf = '';
		proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) res(m[1]); });
		proc.on('exit', (c) => rej(new Error(`chrome exited ${c}: ${buf.slice(-2000)}`)));
	});
	const b = await connect(wsUrl);
	b.proc = proc;
	b.profileDir = dir;
	b.downloadDir = dl;
	b.events = { dialogs: [], requests: [], downloads: [], titles: [], console: [], targets: [] };
	b.sessions = new Map(); // sessionId -> targetInfo (live sessions only)
	b.contexts = []; // { sessionId, ctx } from Runtime.executionContextCreated (all frames of every attached target)
	await b.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl, eventsEnabled: true });
	b.on((m) => {
		const s = m.sessionId;
		const t = s ? b.sessions.get(s) : null;
		switch (m.method) {
			case 'Target.attachedToTarget': {
				const { sessionId, targetInfo, waitingForDebugger } = m.params;
				b.sessions.set(sessionId, { ...targetInfo, parentSession: s ?? null });
				b.events.targets.push({ at: Date.now(), type: targetInfo.type, url: targetInfo.url, targetId: targetInfo.targetId, openerId: targetInfo.openerId });
				setupSession(b, sessionId, targetInfo, waitingForDebugger).catch(() => {});
				break;
			}
			case 'Target.detachedFromTarget':
				b.sessions.delete(m.params.sessionId);
				break;
			case 'Runtime.executionContextCreated':
				b.contexts.push({ sessionId: s, ctx: m.params.context });
				break;
			case 'Runtime.executionContextDestroyed':
				b.contexts = b.contexts.filter((c) => !(c.sessionId === s && c.ctx.id === m.params.executionContextId));
				break;
			case 'Target.targetInfoChanged': {
				const ti = m.params.targetInfo;
				for (const [sid, inf] of b.sessions) if (inf.targetId === ti.targetId) b.sessions.set(sid, { ...ti, parentSession: inf.parentSession });
				if (ti.title) b.events.titles.push({ at: Date.now(), title: ti.title, url: ti.url, type: ti.type });
				break;
			}
			case 'Page.javascriptDialogOpening':
				b.events.dialogs.push({ at: Date.now(), message: m.params.message, type: m.params.type, url: m.params.url, target: t?.url, ttype: t?.type });
				b.send('Page.handleJavaScriptDialog', { accept: false }, s).catch(() => {});
				break;
			case 'Network.requestWillBeSent':
				b.events.requests.push({ at: Date.now(), url: m.params.request.url, method: m.params.request.method, type: m.params.type, target: t?.url, ttype: t?.type, initiator: m.params.initiator?.type });
				break;
			case 'Browser.downloadWillBegin':
				b.events.downloads.push({ at: Date.now(), url: m.params.url, suggestedFilename: m.params.suggestedFilename, frameId: m.params.frameId });
				break;
			case 'Runtime.consoleAPICalled':
				b.events.console.push({ at: Date.now(), kind: 'console.' + m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300), target: t?.url });
				break;
			case 'Log.entryAdded':
				b.events.console.push({ at: Date.now(), kind: 'log.' + m.params.entry.source + '.' + m.params.entry.level, text: m.params.entry.text.slice(0, 400), url: m.params.entry.url, target: t?.url });
				break;
			case 'Runtime.exceptionThrown':
				b.events.console.push({ at: Date.now(), kind: 'exception', text: (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? '').slice(0, 300), target: t?.url });
				break;
		}
	});
	await b.send('Target.setDiscoverTargets', { discover: true });
	await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	b.close = async () => {
		try { await Promise.race([b.send('Browser.close'), sleep(2000)]); } catch {}
		try { proc.kill('SIGKILL'); } catch {}
		b_pids.delete(proc.pid);
		await sleep(150);
		rmSync(dir, { recursive: true, force: true });
	};
	b.mark = () => ({ dialogs: b.events.dialogs.length, requests: b.events.requests.length, downloads: b.events.downloads.length, titles: b.events.titles.length, console: b.events.console.length, targets: b.events.targets.length });
	b.since = (mk) => Object.fromEntries(Object.entries(b.events).map(([k, v]) => [k, v.slice(mk[k])]));
	return b;
}

async function setupSession(b, sessionId, info, waiting) {
	// Do not await the enables before resuming: a target paused on start may not answer until resumed.
	const s = (method, params = {}) => b.send(method, params, sessionId).catch(() => {});
	if (info.type === 'page' || info.type === 'iframe') {
		s('Page.enable'); s('Network.enable'); s('Runtime.enable'); s('Log.enable');
		s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	} else if (/worker/.test(info.type)) {
		s('Network.enable'); s('Runtime.enable');
	}
	if (waiting) await s('Runtime.runIfWaitingForDebugger');
}

export async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0;
	const pending = new Map(), listeners = new Set();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { res, rej } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
		} else for (const l of listeners) l(msg);
	};
	const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
		const i = ++id;
		pending.set(i, { res, rej });
		ws.send(JSON.stringify({ id: i, method, params, sessionId }));
	});
	const on = (fn) => (listeners.add(fn), () => listeners.delete(fn));
	const once = (pred, timeout = 15000) => {
		let off;
		const p = new Promise((res, rej) => {
			const t = setTimeout(() => { off(); rej(new Error('timeout waiting for event')); }, timeout);
			off = on((m) => { if (pred(m)) { clearTimeout(t); off(); res(m); } });
		});
		p.catch(() => {});
		return p;
	};
	return { send, on, once, ws };
}

/** New tab (optionally in a fresh browser context). Returns helpers bound to its session. */
export async function newPage(b, { fresh = false, initScript } = {}) {
	const ctx = fresh ? (await b.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId : undefined;
	if (ctx) await b.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: b.downloadDir, eventsEnabled: true, browserContextId: ctx }).catch(() => {});
	const attached = b.once((m) => m.method === 'Target.attachedToTarget' && m.params.targetInfo.url === 'about:blank' && m.params.targetInfo.type === 'page' && (!ctx || m.params.targetInfo.browserContextId === ctx));
	const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
	let sessionId;
	const m = await attached;
	if (m.params.targetInfo.targetId === targetId) sessionId = m.params.sessionId;
	else {
		for (let i = 0; i < 100 && !sessionId; i++) {
			for (const [sid, inf] of b.sessions) if (inf.targetId === targetId) sessionId = sid;
			if (!sessionId) await sleep(20);
		}
	}
	const s = (method, params = {}) => b.send(method, params, sessionId);
	await s('Page.enable');
	if (initScript) await s('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
	const evaluate = async (expression, { await: aw = true } = {}) => {
		const r = await s('Runtime.evaluate', { expression, awaitPromise: aw, returnByValue: true, userGesture: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const waitFor = async (expr, timeout = 15000) => {
		const t0 = Date.now();
		let last;
		for (;;) {
			try { const v = await evaluate(expr); if (v) return v; last = v; } catch (e) { last = String(e); }
			if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms): ${expr.slice(0, 200)} last=${String(last).slice(0, 200)}`);
			await sleep(15);
		}
	};
	const navigate = async (url, { waitLoad = true, timeout = 20000 } = {}) => {
		const loaded = b.once((x) => x.sessionId === sessionId && (x.method === 'Page.loadEventFired' || x.method === 'Page.navigatedWithinDocument'), timeout);
		const r = await s('Page.navigate', { url });
		if (!r.errorText && waitLoad) await loaded.catch(() => {});
		return r;
	};
	const close = async () => {
		await b.send('Target.closeTarget', { targetId }).catch(() => {});
		if (ctx) await b.send('Target.disposeBrowserContext', { browserContextId: ctx }).catch(() => {});
	};
	return { s, sessionId, targetId, ctx, evaluate, waitFor, navigate, close };
}

/**
 * Evaluate inside a child frame of a page (e.g. the sandboxed pdf.js frame of the viewer wrapper). Works for an
 * out-of-process iframe (its own auto-attached 'iframe' target) and for an in-process frame (its default
 * execution context in the page's session). Returns ev(expr) -> value, or throws after `timeout`.
 */
export async function frameEvaluator(b, pageSessionId, urlRe, timeout = 15000) {
	const t0 = Date.now();
	const find = (ft) => { if (ft.frame.parentId && urlRe.test(ft.frame.url)) return ft.frame; for (const c of ft.childFrames ?? []) { const f = find(c); if (f) return f; } return null; };
	for (;;) {
		for (const [sid, info] of [...b.sessions].reverse())
			if (info.type === 'iframe' && urlRe.test(info.url) && info.parentSession === pageSessionId) {
				const ev = async (expression) => { const r = await b.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
				ev.where = `oopif ${sid}`;
				return ev;
			}
		const tree = await b.send('Page.getFrameTree', {}, pageSessionId).catch(() => null);
		const fr = tree && find(tree.frameTree);
		const c = fr && [...b.contexts].reverse().find((x) => x.sessionId === pageSessionId && x.ctx.auxData?.frameId === fr.id && x.ctx.auxData?.isDefault);
		if (c) {
			const ev = async (expression) => { const r = await b.send('Runtime.evaluate', { expression, contextId: c.ctx.id, returnByValue: true, awaitPromise: true }, pageSessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
			ev.where = `in-process frame ${fr.id}`;
			return ev;
		}
		if (Date.now() - t0 > timeout) throw new Error(`no frame matching ${urlRe} in session ${pageSessionId}`);
		await sleep(50);
	}
}
