// GRS-158: the repository is public, so anyone can fork it, open issues and comment, and only its write, maintain and
// admin collaborators can open pull requests. Which events reach the pc1 runner is decided by each job's `if:`, which
// this file evaluates with GitHub's expression semantics (actions-expression.ts) against synthetic event contexts, for
// every job in every workflow, together with the triggers, the runner a job can land on, its token, its actions and its
// scripts. The guard is not the control for a pull request, whose run uses the pull request's own workflow file;
// docs/ci-runner.md ("Public repository") names the settings that are.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, runs, truthy, type Value } from './actions-expression.ts';

type Job = Record<string, unknown>;
type Workflow = { on: unknown; jobs: Record<string, Job> } & Record<string, unknown>;
const { Bun: bun } = globalThis as unknown as { Bun: { YAML: { parse(s: string): Workflow } } };
const dir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((file) => ({ file, doc: bun.YAML.parse(readFileSync(path.join(dir, file), 'utf8')) }));
const jobs = workflows.flatMap(({ file, doc }) => Object.entries(doc.jobs).map(([id, job]) => ({ name: `${file} ${id}`, job, workflow: doc })));
const steps = (job: Job) => (Array.isArray(job.steps) ? job.steps : []) as Record<string, unknown>[];
const ci = workflows.find((w) => w.file === 'ci.yml')!.doc;

const REPO = 'GridShift-Software/clearcase';
const SHA = 'a'.repeat(40);
type Case = { name: string; github: Record<string, Value> };
const context = (event_name: string, ref: string, event: Record<string, Value>, repository = REPO): Case['github'] => ({
	repository, repository_owner: repository.split('/')[0]!, event_name, ref, sha: SHA, actor: 'someone', event: { repository: { full_name: repository, fork: repository !== REPO }, ...event },
});
const pullRequest = (head: string | null, extra: Record<string, Value> = {}): Record<string, Value> => ({
	action: 'synchronize', number: 7,
	pull_request: {
		number: 7, user: { login: 'someone', type: 'User' }, base: { ref: 'dev', repo: { full_name: REPO, fork: false } },
		head: { ref: 'feature/x', sha: SHA, repo: head === null ? null : { full_name: head, fork: head !== REPO } }, ...extra,
	},
});
const on = (name: string, event_name: string, ref: string, event: Record<string, Value> = {}, repository = REPO): Case => ({ name, github: context(event_name, ref, event, repository) });

const ADMITTED: Case[] = [
	on('a pull request from a branch of this repository', 'pull_request', 'refs/pull/7/merge', pullRequest(REPO)),
	on('a push to dev', 'push', 'refs/heads/dev', { ref: 'refs/heads/dev' }),
	on('a manual run on a branch of this repository', 'workflow_dispatch', 'refs/heads/feature/grs-158-x', { ref: 'refs/heads/feature/grs-158-x', inputs: {} }),
];

const FORK = 'someone/clearcase';
// Who opened or updated a pull request does not decide whether its job runs: a writer can open a pull request from a fork
// (SP2 of GRS-158's first review), and the outsider who owns that fork can push to it afterwards.
const by = (actor: string, c: Case): Case => ({ name: c.name, github: { ...c.github, actor, triggering_actor: actor, event: { ...(c.github.event as Record<string, Value>), sender: { login: actor, type: 'User' } } } });
// Events the workflow does not support, beyond the ones with a row of their own below. The public can cause several of
// them (issues, comments, discussions, forks, stars).
const OTHER_EVENTS = [
	'discussion', 'discussion_comment', 'fork', 'watch', 'pull_request_review', 'pull_request_review_comment', 'workflow_call', 'schedule', 'repository_dispatch',
	'merge_group', 'check_run', 'check_suite', 'create', 'delete', 'deployment', 'deployment_status', 'release', 'status', 'label', 'milestone', 'page_build',
	'public', 'gollum', 'member', 'registry_package', 'branch_protection_rule',
];
const REJECTED: Case[] = [
	on('a pull request from a fork', 'pull_request', 'refs/pull/7/merge', pullRequest(FORK)),
	on('a pull request from a fork a collaborator owns', 'pull_request', 'refs/pull/7/merge', pullRequest('collaborator/clearcase', { user: { login: 'collaborator', type: 'User' }, author_association: 'MEMBER' })),
	by('gridshift-admin', on('a pull request an organization admin opened from an outsider\'s fork', 'pull_request', 'refs/pull/7/merge', pullRequest('outsider/clearcase', { author_association: 'MEMBER', user: { login: 'outsider', type: 'User' } }))),
	by('gridshift-admin', on('a pull request an organization member opened from their own fork', 'pull_request', 'refs/pull/7/merge', { ...pullRequest('gridshift-admin/clearcase', { author_association: 'MEMBER' }), action: 'opened' })),
	by('outsider', on('a push by an outsider to the fork branch of a pull request a member opened', 'pull_request', 'refs/pull/7/merge', { ...pullRequest('outsider/clearcase', { author_association: 'MEMBER' }), action: 'synchronize' })),
	on('a pull request whose fork was deleted', 'pull_request', 'refs/pull/7/merge', pullRequest(null)),
	on('a pull_request_target run for a fork', 'pull_request_target', 'refs/heads/dev', pullRequest(FORK)),
	on('a pull_request_target run for a branch of this repository', 'pull_request_target', 'refs/heads/dev', pullRequest(REPO)),
	on('a comment from the public on a pull request', 'issue_comment', 'refs/heads/main', { action: 'created', issue: { number: 7, pull_request: { url: 'x' } }, comment: { body: '/run ci', author_association: 'NONE' } }),
	on('an issue opened by the public', 'issues', 'refs/heads/main', { action: 'opened', issue: { number: 8, author_association: 'NONE' } }),
	on('a workflow_run after a fork\'s CI run', 'workflow_run', 'refs/heads/main', { workflow_run: { event: 'pull_request', head_repository: { full_name: FORK } } }),
	on('a push to dev in a fork', 'push', 'refs/heads/dev', { ref: 'refs/heads/dev' }, FORK),
	on('a pull request between branches of a fork', 'pull_request', 'refs/pull/3/merge', pullRequest(FORK), FORK),
	on('a manual run in a fork', 'workflow_dispatch', 'refs/heads/dev', { ref: 'refs/heads/dev', inputs: {} }, FORK),
	on('a push to main', 'push', 'refs/heads/main', { ref: 'refs/heads/main' }),
	on('a push to a feature branch', 'push', 'refs/heads/feature/x', { ref: 'refs/heads/feature/x' }),
	on('a push to a branch whose name ends in dev', 'push', 'refs/heads/feature/dev', { ref: 'refs/heads/feature/dev' }),
	on('a push of a tag named dev', 'push', 'refs/tags/dev', { ref: 'refs/tags/dev' }),
	...OTHER_EVENTS.map((e) => on(`a ${e} event`, e, 'refs/heads/main', { action: 'created' })),
];

// Whether GitHub starts a run of the workflow for the event, from its on: block: the event's name, a push's branch by
// exact name (a tag push does not match a branches filter), a pull request's activity type. Any other filter throws.
const FILTERS: Record<string, string[]> = { push: ['branches'], pull_request: ['types'], workflow_dispatch: ['inputs'] };
function starts(on: unknown, github: Case['github']): boolean {
	const triggers = (typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on) as Record<string, unknown>;
	const name = String(github.event_name), event = github.event as Record<string, Value>;
	if (!Object.hasOwn(triggers, name)) return false;
	const filter = (triggers[name] ?? {}) as Record<string, unknown>;
	for (const key of Object.keys(filter)) if (!(FILTERS[name] ?? []).includes(key)) throw new Error(`starts(): the ${name} filter ${key} is not modelled`);
	if (name === 'push' && filter.branches !== undefined) {
		const branches = filter.branches;
		if (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string' || /[*?+![\]]/.test(b))) throw new Error(`starts(): only exact branch names are modelled, not ${JSON.stringify(branches)}`);
		return String(github.ref).startsWith('refs/heads/') && branches.includes(String(github.ref).slice('refs/heads/'.length));
	}
	if (name === 'pull_request') return ((filter.types as string[] | undefined) ?? ['opened', 'synchronize', 'reopened']).includes(String(event.action));
	return true;
}
// The rows a trigger list of pull_request, push to dev and workflow_dispatch refuses by itself; the rest reach the guard.
const refusedByTriggers = REJECTED.filter(({ github: g }) => !(g.event_name === 'pull_request' || g.event_name === 'workflow_dispatch' || (g.event_name === 'push' && g.ref === 'refs/heads/dev')));

describe('workflow admission', () => {
	it('evaluates a guard on every job of every workflow', () => {
		expect(jobs.length).toBeGreaterThan(0);
	});
	describe.each(jobs)('$name', ({ job }) => {
		it.each(REJECTED)('does not run for $name, whatever its workflow\'s on: lists', ({ github }) => {
			expect(runs(job.if, { github, needs: {} })).toBe(false);
		});
	});
	describe.each(workflows)('$file', ({ doc }) => {
		it.each(refusedByTriggers)('starts no run for $name', ({ github }) => {
			expect(starts(doc.on, github)).toBe(false);
		});
	});
	it.each(ADMITTED)('CI starts and runs its check job for $name', ({ github }) => {
		expect(starts(ci.on, github)).toBe(true);
		expect(runs(ci.jobs.check!.if, { github, needs: {} })).toBe(true);
	});
});

// The labels clearcase-pc1-vm carries (docs/ci-runner.md). GitHub gives a job to a runner that has every label the job
// names, and GitHub's own runners never carry self-hosted.
const PC1 = ['self-hosted', 'Linux', 'X64', 'clearcase-pc1'];
function labels(runsOn: unknown): string[] {
	const list: unknown = typeof runsOn === 'string' ? [runsOn] : runsOn;
	if (!Array.isArray(list) || list.length === 0 || list.some((l) => typeof l !== 'string' || l.includes('${{')))
		throw new Error(`runs-on ${JSON.stringify(runsOn)} is not a literal list of labels: a group or an expression could pick a GitHub-hosted runner`);
	return list.map((l: string) => l.toLowerCase());
}
// A token permission that is not read or none, for the job's own permissions or else its workflow's.
function writes(permissions: unknown): string[] {
	if (permissions === 'read-all' || (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions) && Object.values(permissions).every((v) => v === 'read' || v === 'none'))) return [];
	return [JSON.stringify(permissions ?? 'unset, so the repository default applies')];
}
const docs = readFileSync(new URL('../../docs/ci-runner.md', import.meta.url), 'utf8');
const policy = docs.slice(docs.indexOf('\n## Public repository'), docs.indexOf('\n## ', docs.indexOf('\n## Public repository') + 1));
// The actions the repository's Actions settings allow, as docs/ci-runner.md records them: exact commit SHAs only.
const ALLOWED = [...policy.matchAll(/`([\w.-]+\/[\w.-]+@[0-9a-f]{40})`/g)].map((m) => m[1]!);

describe('public repository workflow policy', () => {
	describe.each(jobs)('$name', ({ job, workflow }) => {
		it('can land only on clearcase-pc1-vm, never on a GitHub-hosted runner', () => {
			const wanted = labels(job['runs-on']);
			expect(wanted).toContain('self-hosted');
			expect(wanted).toContain('clearcase-pc1');
			expect(wanted.filter((l) => !PC1.map((p) => p.toLowerCase()).includes(l)), 'labels clearcase-pc1-vm lacks').toEqual([]);
		});
		it('has a token that can only read, and no container, service or reusable workflow', () => {
			expect(writes(job.permissions ?? workflow.permissions)).toEqual([]);
			for (const key of ['container', 'services', 'uses', 'secrets']) expect(job[key], key).toBeUndefined();
		});
		it('stops within an hour', () => {
			expect(typeof job['timeout-minutes']).toBe('number');
			expect(job['timeout-minutes']).toBeGreaterThan(0);
			expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
		});
		it('uses only the allowed actions, and checks out without keeping a credential', () => {
			for (const step of steps(job).filter((s) => s.uses !== undefined)) expect(ALLOWED, String(step.uses)).toContain(step.uses);
			for (const step of steps(job).filter((s) => String(s.uses).startsWith('actions/checkout@'))) {
				const inputs = (step.with ?? {}) as Record<string, unknown>;
				expect(inputs['persist-credentials']).toBe(false);
				for (const key of ['repository', 'token', 'ssh-key']) expect(inputs[key], key).toBeUndefined();
			}
		});
		it('names no person, role or sender in its guard, so being a member does not admit a fork\'s code', () => {
			expect(String(job.if ?? '')).not.toMatch(/\b(actor|triggering_actor|sender|author_association|login)\b/i);
		});
		it('puts no ${{ }} expression inside a script, where a branch name or title would become code', () => {
			for (const step of steps(job)) expect(String(step.run ?? ''), String(step.name ?? step.run)).not.toContain('${{');
		});
	});
	it('docs/ci-runner.md lists exactly the actions the workflows use', () => {
		expect(ALLOWED.length).toBeGreaterThan(0);
		expect(new Set(ALLOWED)).toEqual(new Set(jobs.flatMap(({ job }) => steps(job).map((s) => s.uses).filter((u) => u !== undefined))));
	});
});

describe('the expression evaluator the admission tests rely on', () => {
	const value = (source: string, github: Record<string, Value> = {}) => parse(source)({ github });
	it('compares strings without case and mismatched types as numbers, as GitHub does', () => {
		expect(value("'GridShift-Software/ClearCase' == 'gridshift-software/clearcase'")).toBe(true);
		expect(value("'1' == 1")).toBe(true);
		expect(value("'one' == 1")).toBe(false);
		expect(value('null == 0')).toBe(true);
		expect(value("'dev' != 'Dev'")).toBe(false);
	});
	it('reads a missing property as null, and && and || return an operand', () => {
		expect(value('github.event.pull_request.head.repo.full_name', { event: { pull_request: { head: { repo: null } } } })).toBe(null);
		expect(value("github.missing && 'x'")).toBe(null);
		expect(value("github.missing || 'fallback'")).toBe('fallback');
		expect(value("contains('refs/heads/DEV', 'dev') && startsWith('refs/heads/dev', 'REFS/')")).toBe(true);
		expect(truthy(value("''"))).toBe(false);
	});
	it('adds the implied success() unless the condition names a status function', () => {
		expect(runs("github.event_name == 'push'", { github: { event_name: 'push' } }, 'failure')).toBe(false);
		expect(runs("always() && github.event_name == 'push'", { github: { event_name: 'push' } }, 'failure')).toBe(true);
		expect(runs('${{ !cancelled() }}', { github: {} }, 'cancelled')).toBe(false);
		expect(runs(undefined, { github: {} })).toBe(true);
	});
	it('refuses what it cannot evaluate, instead of guessing', () => {
		for (const source of ["vars.ALLOW == 'yes'", 'github.event.labels.*.name', "fromJSON('[]')", '1 < 2', "github.ref == 'a' ||", "format('{0}', 'x')"])
			expect(() => value(source), source).toThrow(/actions-expression/);
		expect(() => runs("x-${{ github.ref }}", { github: {} })).toThrow(/actions-expression/);
	});
});
