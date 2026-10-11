// Slot plug-in: the overview's Freshness card (rescan-freshness, GRS-20). Its first line is the build stamp, its
// second the last rescan. It needs no seeded user work, so seed and cleanup change nothing.
export default {
	read: (p) => p.evaluate(`(() => { const t = (id) => document.getElementById(id)?.textContent.replace(/\\s+/g, ' ').trim() ?? ''; return { value: t('freshness-stamp'), sub: t('freshness-scan') }; })()`),
	async seed() {},
	async cleanup() {},
};
