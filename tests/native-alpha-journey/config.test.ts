import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseUrlProblems, loadConfig, stateFileProblem, type ConfigIo } from './config.ts';
import { simRoutes } from './world.ts';

const ROOT = '/work/clearcase';
const OUT = '/home/test/journey-out';
const cookie = (value: string) => JSON.stringify({ cookies: [{ name: '__session', value, domain: 'native.example.invalid', path: '/', expires: -1, httpOnly: true, secure: true }], origins: [] });
const files: Record<string, string> = {
  '/priv/a.json': cookie('aaaaaaaaaaaaaaaa'), '/priv/b.json': cookie('bbbbbbbbbbbbbbbb'), '/priv/o.json': cookie('cccccccccccccccc'), '/priv/r.json': cookie('dddddddddddddddd'),
  '/priv/routes.json': JSON.stringify(simRoutes),
};
const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CLEARCASE_JOURNEY_BASE_URL: 'https://native.example.invalid', CLEARCASE_JOURNEY_EXPECTED_SHA: 'a'.repeat(40), CLEARCASE_JOURNEY_CASE_ID: 'case-1', CLEARCASE_JOURNEY_FOREIGN_CASE_ID: 'foreign-1', CLEARCASE_JOURNEY_OUT: OUT,
  CLEARCASE_JOURNEY_CLIENT_A_STATE: '/priv/a.json', CLEARCASE_JOURNEY_OPERATOR_B_STATE: '/priv/b.json', CLEARCASE_JOURNEY_OTHER_CLIENT_STATE: '/priv/o.json', CLEARCASE_JOURNEY_REVOKED_STATE: '/priv/r.json',
  CLEARCASE_JOURNEY_ROUTES: '/priv/routes.json', ...extra,
});
const io = (e: Record<string, string | undefined>, f: Record<string, string> = files): ConfigIo => ({ env: e, read: (p) => f[p] ?? null, repoRoot: ROOT, nowMs: Date.parse('2026-10-25T12:00:00Z') });
const hold = (phase: 'upload-import' | 'signoff-publish' | 'after-restart', e: Record<string, string | undefined>, f?: Record<string, string>) => {
  const l = loadConfig(phase, io(e, f));
  return l.kind === 'hold' ? l.reasons.join('\n') : null;
};

describe('a journey without its real prerequisites is a HOLD, never a skip or a pass', () => {
  it('a complete configuration is ready', () => {
    const l = loadConfig('upload-import', io(env()));
    expect(l.kind).toBe('ready');
  });
  it('an empty environment holds on every prerequisite and names the variables', () => {
    const r = hold('upload-import', {})!;
    for (const name of ['BASE_URL', 'EXPECTED_SHA', 'CASE_ID', 'OUT', 'CLIENT_A_STATE', 'OPERATOR_B_STATE', 'OTHER_CLIENT_STATE', 'REVOKED_STATE']) expect(r).toContain(`CLEARCASE_JOURNEY_${name}`);
    for (const port of ['operator.import', 'operator.preview', 'recovery.export']) expect(r).toContain(port);
  });
  it.each([
    ['http', 'http://native.example.invalid', 'https'],
    ['loopback', 'https://localhost', 'local or private'],
    ['an IP address', 'https://203.0.113.9', 'local or private'],
    ['workers.dev', 'https://clearcase.example.workers.dev', 'workers.dev'],
    ['a path', 'https://native.example.invalid/app', 'origin only'],
    ['credentials', 'https://u:p@native.example.invalid', 'credentials'],
  ])('refuses a base URL with %s', (_n, url, why) => {
    expect(baseUrlProblems(url).problems.join()).toContain(why);
  });
  it.each([undefined, '', 'case-1', 'bad/id'])('requires a distinct provisioned foreign case (%s)', (foreign) => {
    expect(hold('upload-import', env({ CLEARCASE_JOURNEY_FOREIGN_CASE_ID: foreign }))).toContain('CLEARCASE_JOURNEY_FOREIGN_CASE_ID');
  });
  it('holds when the owning export contract or authoritative submission captures are missing', () => {
    const routes = structuredClone(simRoutes);
    delete (routes.ports['recovery.export'] as Partial<typeof routes.ports['recovery.export']>).exportContract;
    expect(hold('upload-import', env(), { ...files, '/priv/routes.json': JSON.stringify(routes) })).toContain('exportContract');
    const missing = structuredClone(simRoutes);
    delete (missing.ports['operator.submission.get'].captures as Partial<typeof missing.ports['operator.submission.get']['captures']>).manifestBase64;
    expect(hold('upload-import', env(), { ...files, '/priv/routes.json': JSON.stringify(missing) })).toContain('capture manifestBase64');
  });
  it('refuses a short or non-hex expected revision', () => {
    expect(hold('upload-import', env({ CLEARCASE_JOURNEY_EXPECTED_SHA: 'abc123' }))).toContain('40-hex');
  });
  it('refuses a session file inside the checkout and a relative one', () => {
    expect(stateFileProblem(path.join(ROOT, 'tests/fixtures/a.json'), ROOT)).toContain('outside the checkout');
    expect(stateFileProblem(path.join(ROOT, '.local/sessions/a.json'), ROOT)).toBeNull();
    expect(stateFileProblem('sessions/a.json', ROOT)).toContain('absolute');
  });
  it('refuses an expired session, a session for another host, and two actors sharing one session', () => {
    const expired = JSON.stringify({ cookies: [{ name: '__session', value: 'x'.repeat(16), domain: 'native.example.invalid', path: '/', expires: 1000, secure: true }] });
    expect(hold('upload-import', env(), { ...files, '/priv/a.json': expired })).toContain('CLIENT_A_STATE: no unexpired cookie');
    const other = JSON.stringify({ cookies: [{ name: '__session', value: 'x'.repeat(16), domain: 'other.example.invalid', path: '/', expires: -1, secure: true }] });
    expect(hold('upload-import', env(), { ...files, '/priv/b.json': other })).toContain('OPERATOR_B_STATE: no unexpired cookie');
    expect(hold('upload-import', env(), { ...files, '/priv/b.json': files['/priv/a.json'] })).toContain('every actor needs its own session');
  });
  it('refuses a state file that is not a storage state', () => {
    expect(hold('upload-import', env(), { ...files, '/priv/a.json': '{"token":"x"}' })).toContain('not a Playwright storage state');
    expect(hold('upload-import', env(), { ...files, '/priv/a.json': 'nope' })).toContain('not JSON');
  });
  it('phase 2 needs the human confirmation of the exact identity and a non-secret reviewer label', () => {
    expect(hold('signoff-publish', env())).toContain('HUMAN_SIGNOFF_IDENTITY_SHA256');
    expect(hold('signoff-publish', env({ CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256: 'a'.repeat(64), CLEARCASE_JOURNEY_HUMAN_REVIEWER_REF: 'dian@example.com' }))).toContain('REVIEWER_REF');
    expect(loadConfig('signoff-publish', io(env({ CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256: 'a'.repeat(64), CLEARCASE_JOURNEY_HUMAN_REVIEWER_REF: 'Reviewer One' }))).kind).toBe('ready');
  });
  it('a reasons list never carries a cookie value', () => {
    const r = hold('upload-import', env(), { ...files, '/priv/b.json': files['/priv/a.json'] })!;
    for (const secret of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']) expect(r).not.toContain(secret);
  });
});
