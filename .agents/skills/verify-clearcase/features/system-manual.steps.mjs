// Drive steps of features/system-manual.md (GRS-20): the badges, the link-sample check, and Back from Rescan & Update
// to the manual with its list and the focused heading.
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

export const steps = [
	{
		id: 'system-manual', feature: 'system-manual', title: 'Manual: badges, Verify link sample, then Rescan & Update and Back',
		async run(x) {
			await x.click('#nav-manual');
			await x.waitReady('manual');
			const badges = await x.page.evaluate(`document.getElementById('manual-badges').textContent.replace(/\\s+/g, ' ').trim()`);
			await x.click('#manual-verify');
			await x.page.waitFor(`!!document.getElementById('manual-link-list')`, 20000);
			const verified = await x.text('#manual-verify-result');
			const found = await x.page.evaluate(`document.querySelectorAll('#manual-link-list tr[data-result="found"]').length`);
			const shot = await x.shot('system-manual-links');
			await x.click('#manual-rescan');
			await x.waitReady('rescan_tab');
			await x.page.evaluate('history.back(), true');
			await x.page.waitFor(`document.querySelector('main')?.dataset.ready === 'manual' && !!document.getElementById('manual-link-list')`, 20000);
			await new Promise((r) => setTimeout(r, 150));
			const focus = await x.page.evaluate(`document.activeElement?.hasAttribute('data-page-heading') ?? false`);
			must(/^Documents 8 \(\+1 via rescan\) /.test(badges) && verified === '1 of 1 found in the case folder.' && found === 1 && focus, `manual ${JSON.stringify({ badges, verified, found, focus })}`);
			return { badges, verified, found, focus, shot };
		},
	},
];
