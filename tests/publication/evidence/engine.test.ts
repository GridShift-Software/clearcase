import { describe, expect, it } from 'vitest';
import { finish, setup } from './harness.ts';

describe('resumable evidence build on migrated SQLite', () => {
  it('resumes 3,000 observations after seeded interruptions and binds every item to the root', async () => {
    const baseline = setup();
    const root = await finish(baseline.engine('original'));
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    baseline.db.close();
    for (const seed of [1, 29, 1009, 65537]) {
      const run = setup();
      let engine = run.engine('before');
      const interruptAt = 1 + ((seed * 1103515245 + 12345) >>> 0) % 140;
      const resumed = await finish({ step: () => engine.step() }, interruptAt, () => { run.advance(101); engine = run.engine('after'); });
      expect(resumed).toBe(root);
      run.db.close();
    }
    const changed = setup({ changed: true });
    expect(await finish(changed.engine('changed'))).not.toBe(root);
    changed.db.close();
  });
  it('refuses a concurrent builder and safely transfers an expired lease', async () => {
    const run = setup();
    const first = run.engine('first'), second = run.engine('second');
    expect((await first.step()).kind).toBe('progress');
    const count = run.db.prepare('SELECT count(*) AS n FROM pub_evidence_item').get()?.n;
    expect((await second.step()).kind).toBe('leased');
    expect(run.db.prepare('SELECT count(*) AS n FROM pub_evidence_item').get()?.n).toBe(count);
    run.advance(101);
    expect((await second.step()).kind).toBe('progress');
    expect((await first.step()).kind).toBe('leased');
    expect(await finish(second)).toMatch(/^[0-9a-f]{64}$/);
    run.db.close();
  });
});
