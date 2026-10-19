// The v5 stack lane's dependency-pin rules (tests/e2e/pilot/v5-lanes.mjs), kept pure so tests/e2e/pilot/lib/pins.test.ts can drive them.

// GRS-97's handoff (docs/acceptance/viewers/handoff.md) pins xlsx 0.20.3 by this integrity; npm's own `xlsx` is the stale 0.18.5.
export const XLSX_SHA512 = 'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==';
const EXACT = /^\d+\.\d+\.\d+$/;
// SheetJS publishes only from its own CDN. The one exception to exact x.y.z: the package `xlsx`, from that host over https, one version twice.
const SHEETJS = /^https:\/\/cdn\.sheetjs\.com\/xlsx-(\d+\.\d+\.\d+)\/xlsx-(\d+\.\d+\.\d+)\.tgz$/;
const sheetjs = (name, value) => {
	const m = name === 'xlsx' ? SHEETJS.exec(value) : null;
	return m !== null && m[1] === m[2];
};

/**
 * The dependencies that are not an exact pin.
 * @param {Record<string, string>} deps
 * @returns {[string, string][]}
 */
export function unpinned(deps) {
	return Object.entries(deps).filter(([name, v]) => !EXACT.test(v) && !sheetjs(name, v));
}

/**
 * What bun.lock must hold for xlsx when package.json names it by URL: the same tarball with GRS-97's sha512.
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} pj
 * @param {string | null} lock the text of bun.lock, or null when it is absent
 * @returns {string[]}
 */
export function xlsxLockProblems(pj, lock) {
	const url = { ...pj.dependencies, ...pj.devDependencies }.xlsx;
	if (url === undefined || EXACT.test(url)) return [];
	if (lock === null) return ['bun.lock is missing'];
	const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const hash = new RegExp(`\\[\\s*"xlsx@${escaped}"\\s*,[\\s\\S]*?"(sha512-[^"]+)"\\s*\\]`).exec(lock)?.[1];
	if (hash === undefined) return [`bun.lock holds no xlsx entry for ${url}`];
	return hash === XLSX_SHA512 ? [] : [`bun.lock records ${hash} for xlsx, not the integrity GRS-97 recorded`];
}
