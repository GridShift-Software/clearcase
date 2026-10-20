// GRS-158: the repository is public, so anyone can fork it, open issues and comment, and only its write, maintain and
// admin collaborators can open pull requests. Which events reach the pc1 runner is decided by each job's `if:`, which
// this file evaluates with GitHub's expression semantics (actions-expression.ts) against synthetic event contexts, for
// every job in every workflow. The guard is not the control for a pull request, whose run uses the pull request's own
// workflow file; docs/ci-runner.md ("Public repository") names the settings that are.
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
const jobs = workflows.flatMap(({ file, doc }) => Object.entries(doc.jobs).map(([id, job]) => ({ name: `${file} ${id}`, job })));
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

describe('workflow admission', () => {
	it('evaluates a guard on every job of every workflow', () => {
		expect(jobs.length).toBeGreaterThan(0);
	});
	describe.each(jobs)('$name', ({ job }) => {
		it.each(REJECTED)('does not run for $name, whatever its workflow\'s on: lists', ({ github }) => {
			expect(runs(job.if, { github, needs: {} })).toBe(false);
		});
	});
	it.each(ADMITTED)('CI runs its check job for $name', ({ github }) => {
		expect(runs(ci.jobs.check!.if, { github, needs: {} })).toBe(true);
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
