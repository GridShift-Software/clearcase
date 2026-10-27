import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(new URL('../../../deploy/client/routes/+layout.svelte', import.meta.url), 'utf8');

function color(name: string): string {
	const value = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
	if (!value) throw new Error(`Missing token --${name}`);
	const alias = value.match(/^var\(--([\w-]+)\)$/);
	if (alias) return color(alias[1]);
	if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Expected hex color for --${name}: ${value}`);
	return value;
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
	const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

it('keeps focus and control boundaries distinguishable on hosted surfaces', () => {
	expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus-ring\)/);
	expect(css).toMatch(/input:not\(\[type='checkbox'\]\)[^{]+select, textarea\s*\{[^}]*border:\s*1px solid var\(--border-control\)/);
	for (const token of ['focus-ring', 'border-control']) {
		for (const background of ['surface', 'canvas', 'subtle']) {
			expect(contrast(color(token), color(background)), `${token} against ${background}`).toBeGreaterThanOrEqual(3);
		}
	}
});

it('keeps the focus ring visible on the navy hosted header', () => {
	expect(css).toMatch(/\.hosted a:focus-visible\s*\{[^}]*outline-color:\s*var\(--surface\)/);
	expect(contrast(color('surface'), color('navy')), 'header focus ring against navy').toBeGreaterThanOrEqual(3);
});
