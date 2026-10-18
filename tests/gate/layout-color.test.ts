// scripts/verify/layout-color.mjs: the contrast check measures against what is painted, including a gradient background (GRS-48 evidence run).
import { describe, expect, it } from 'vitest';
import { COLOR } from '../../scripts/verify/layout-color.mjs';

type Style = { backgroundColor: string; backgroundImage?: string; backgroundSize?: string; backgroundRepeat?: string };
const GRADIENT = 'linear-gradient(rgb(26, 67, 114) 0%, rgb(16, 43, 78) 52%, rgb(10, 28, 52) 100%)';
const kit = (chain: Style[]) => {
	const els = chain.map((s, i) => ({ s, parentElement: null as unknown }));
	els.forEach((e, i) => { e.parentElement = els[i + 1] ?? null; });
	const getComputedStyle = (e: { s: Style }) => ({ backgroundImage: 'none', backgroundSize: 'auto', backgroundRepeat: 'repeat', ...e.s });
	const k = new Function('getComputedStyle', `${COLOR}; return { bgOf, ratio, rgba };`)(getComputedStyle);
	return { el: els[0], ...k };
};
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

describe('layout contrast background', () => {
	it('a transparent button on the page background is the page background', () => {
		const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, { backgroundColor: 'rgb(244, 247, 251)' }]);
		expect(ratio(WHITE, bgOf(el, WHITE))).toBeLessThan(1.2);
	});

	it('white text on a button with a dark gradient is measured against the gradient, whatever background-color lies under it', () => {
		for (const under of ['rgba(0, 0, 0, 0)', 'rgb(165, 174, 186)']) {
			const { el, bgOf, ratio } = kit([{ backgroundColor: under, backgroundImage: GRADIENT }, { backgroundColor: 'rgb(244, 247, 251)' }]);
			expect(ratio(WHITE, bgOf(el, WHITE)), under).toBeGreaterThan(4.5);
		}
	});

	it('takes the stop with the least contrast, so a gradient that is light at one end fails', () => {
		const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(rgb(10, 28, 52) 0%, rgb(240, 240, 240) 100%)' }]);
		expect(ratio(WHITE, bgOf(el, WHITE))).toBeLessThan(1.2);
	});

	it('composites a translucent stop over the layers beneath instead of dropping it', () => {
		const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(rgb(10, 28, 52), rgba(255, 255, 255, 0.9))' }, { backgroundColor: 'rgb(255, 255, 255)' }]);
		expect(ratio(WHITE, bgOf(el, WHITE))).toBeLessThan(1.2);
	});

	it('a gradient whose stops are all translucent is composited over the page, not replaced by it', () => {
		const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.2))' }, { backgroundColor: 'rgb(10, 28, 52)' }]);
		const bg = bgOf(el, WHITE);
		expect(bg.r).toBeCloseTo(132.5, 1);
		expect(bg.g).toBeCloseTo(141.5, 1);
		expect(bg.b).toBeCloseTo(153.5, 1);
		expect(ratio(WHITE, bg)).toBeLessThan(4.5);
	});

	it('a solid background keeps its colour', () => {
		const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgb(10, 28, 52)' }, { backgroundColor: 'rgb(255, 255, 255)' }]);
		expect(bgOf(el, WHITE)).toEqual({ r: 10, g: 28, b: 52, a: 1 });
		expect(ratio(WHITE, bgOf(el, WHITE))).toBeGreaterThan(15);
	});

	it('a gradient that may not cover its element (own size or no repeat) is weighed against what lies beneath', () => {
		for (const own of [{ backgroundSize: '50% 50%' }, { backgroundRepeat: 'no-repeat' }]) {
			const { el, bgOf, ratio } = kit([{ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: GRADIENT, ...own }, { backgroundColor: 'rgb(255, 255, 255)' }]);
			expect(ratio(WHITE, bgOf(el, WHITE)), JSON.stringify(own)).toBeLessThan(1.2);
		}
	});
});
