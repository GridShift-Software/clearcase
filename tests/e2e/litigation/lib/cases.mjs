// Synthetic cases of the litigation browser suite (GRS-18), built through GRS-10's real converter
// (tests/e2e/pilot/lib/fixtures.ts buildCase). Nothing here comes from a case: every value is invented.
import { buildCase } from '../../pilot/lib/fixtures.ts';

export const CASE_ID = 'e2e-litigation';

/** The checklist's literal conflict example (docs/reference/view-checklist.md, Conflict Check). */
// a second person (GRS-18 r2, D12) makes a swap or an off-by-one in the scope line's counts fail
export const PEOPLE = [{ name: 'Ann Lee', email: 'ann@x.test', org: 'Org A', sent: 1, received: 1, total: 2, role: '' }, { name: 'Cy Ode', email: 'cy@y.test', org: 'Other Co', sent: 0, received: 1, total: 1, role: '' }];
export const ENTITIES = [{ name: 'Org A Ltd', role: 'supplier', note: '' }];

/**
 * Enforcement steps: phase 1 reappears after phase 2 (grouped by first appearance), one imported status outside
 * ENF_OPTS (S-enforcement_tab-2), one duplicate {phase, step} (disclosed, no status), and authored text with a
 * citation that resolves and one that does not.
 */
export const ENFORCEMENT = [
	{ phase: '1 · Start', step: 'Synthetic step A', basis: 'Invented basis, see [[OD-001]]', status: 'To do', note: 'Invented note, see [[ZZ-404]]' },
	{ phase: '2 · Next', step: 'Synthetic step B', basis: 'Invented basis B', status: 'Awaiting counsel', note: '' },
	{ phase: '1 · Start', step: 'Synthetic step C', basis: 'Invented basis C', status: 'Contingent', note: '' },
	{ phase: '3 · Twice', step: 'Synthetic twin', basis: 'Invented basis D', status: 'Monitor', note: '' },
	{ phase: '3 · Twice', step: 'Synthetic twin', basis: 'Invented basis E', status: 'Done', note: '' },
];

const url = (p) => './' + p.split('/').map(encodeURIComponent).join('/');

/** The litigation datasets of the main case. */
function lit(roots, { enforcement = ENFORCEMENT } = {}) {
	Object.assign(roots.DATA.lit, {
		enforcement,
		legality: {
			intro: 'An invented risk narrative citing [[OD-001]].',
			docs: [
				{ ref: 'OD-001', date: '2001-02-03', title: '(12) Synthetic agreement.pdf', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') },
				{ ref: 'OD-002', date: '', title: 'Synthetic invoice', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') },
			],
			scenarios: [
				{ scenario: 'Synthetic base', effect: 'Invented effect', prob: 'Base case', action: 'Invented action' },
				{ scenario: 'Synthetic material', effect: 'Invented effect', prob: 'Material risk', action: 'Invented action' },
				{ scenario: 'Synthetic possible', effect: 'Invented effect', prob: 'Possible', action: 'Invented action' },
			],
			factors: [{ factor: 'Synthetic factor', note: 'Invented note' }],
		},
		authorities: [
			{ topic: 'Synthetic topic 1', authority: 'Invented v Invented', proposition: 'An invented proposition citing [[OD-001]]' },
			{ topic: 'Synthetic topic 2', authority: 'Invented Act 1 of 2001, s1', proposition: 'Another, with a comma' },
		],
		elements: [
			{ element: 'Synthetic element 1', must: 'Invented requirement', evidence: 'Invented evidence OD-001', witness: 'Synthetic Witness One', tab: 'chronology' },
			{ element: 'Synthetic element 2', must: 'Invented requirement 2', evidence: 'Invented evidence 2', witness: 'Synthetic Witness Two', tab: 'no_such_tab' },
		],
		crossexam_seed: [
			{ witness: 'Seed witness 1', topic: 'Seed topic 1', put: 'Invented put citing [[OD-002]]', docs: 'OD-002' },
			{ witness: 'Seed witness 2', topic: 'Seed topic 2', put: 'Invented put 2', docs: '' },
		],
	});
}

export const mainCase = (dir) => buildCase(dir, { caseId: CASE_ID, edit: (r) => { r.DATA.people = PEOPLE; r.DATA.entities = ENTITIES; lit(r); } });

/** v2 of the main case on the same folder: the enforcement steps reordered (S-index-keys). */
export const reorderedCase = (dir, caseDir) => buildCase(dir, { caseId: CASE_ID, caseDir, edit: (r) => { r.DATA.people = PEOPLE; r.DATA.entities = ENTITIES; lit(r, { enforcement: [ENFORCEMENT[2], ENFORCEMENT[1], ENFORCEMENT[0], ENFORCEMENT[3], ENFORCEMENT[4]] }); } });

/**
 * v3 of the main case on the same folder (GRS-18 r2, D8 and D9): step B's imported status changed to one in ENF_OPTS,
 * so a saved "Awaiting counsel" is no longer offered, and a new step E whose imported status is ''.
 */
export const changedCase = (dir, caseDir) => buildCase(dir, { caseId: CASE_ID, caseDir, edit: (r) => { r.DATA.people = PEOPLE; r.DATA.entities = ENTITIES; lit(r, { enforcement: [ENFORCEMENT[0], { ...ENFORCEMENT[1], status: 'In progress' }, ENFORCEMENT[2], { phase: '2 · Next', step: 'Synthetic step E', basis: 'Invented basis E', status: '', note: '' }] }); } });

/** Another case whose litigation tables are all empty (empty states, an empty export). */
export const emptyCase = (dir) => buildCase(dir, { caseId: 'e2e-litigation-empty', edit: (r) => {
	r.DATA.people = []; r.DATA.entities = [];
	Object.assign(r.DATA.lit, { enforcement: [], authorities: [], elements: [], crossexam_seed: [], legality: { intro: '', docs: [], scenarios: [], factors: [] } });
} });

/** A case whose package carries no view-content fields (built without viewer code): the exports' neutral names. */
export const neutralCase = (dir) => buildCase(dir, { caseId: 'e2e-litigation-neutral', viewCode: false });

/** A dataset's data as the built package carries it (`datasets/<key>.json`), or undefined. */
export function pkgData(sc, key) {
	const f = sc.files.get(`datasets/${key}.json`);
	return f ? JSON.parse(new TextDecoder().decode(f)).data : undefined;
}

/** One plain-text field of a package's view-content dataset, or null. */
export function viewContentText(sc, view, field) {
	const f = sc.files.get('datasets/view-content.json');
	const v = f ? JSON.parse(new TextDecoder().decode(f)).data?.[view]?.[field] : undefined;
	return typeof v === 'string' && v.trim() ? v : null;
}
