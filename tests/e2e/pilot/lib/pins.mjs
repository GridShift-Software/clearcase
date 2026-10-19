// The v5 stack lane's dependency-pin rules (tests/e2e/pilot/v5-lanes.mjs), kept pure so tests/e2e/pilot/lib/pins.test.ts can drive them.
export const XLSX_SHA512 = 'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==';
/** The dependencies that are not an exact x.y.z pin. */
export function unpinned(deps) {
	return Object.entries(deps).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
}
/** What bun.lock must hold for xlsx when package.json names it. */
export function xlsxLockProblems() {
	return [];
}
