// The run's pids.jsonl: one row per process the run starts, written by main.mjs, inner.mjs and drive.mjs and read by
// main.mjs's cleanupRun. A row names the process by pid AND by its start time (field 22 of /proc/<pid>/stat, as
// scripts/pidfile.ts reads it, in ticks since boot) with the boot it counts from, and the run by its scratch's name: Linux reuses pids, so a pid alone proves nothing.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { processStart } from '../../../../scripts/pidfile.ts';

/** This boot's id: a start time counts ticks since boot, so the same pid and start can recur after a reboot. */
export const bootId = () => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } };

/** `cfg.pidFile` is `<scratch>/pids.jsonl`; the run is named by `<scratch>`'s basename. */
export const recordPid = (pidFile, role, pid) =>
	appendFileSync(pidFile, JSON.stringify({ role, pid, start: processStart(pid), boot: bootId(), runId: basename(dirname(pidFile)), at: new Date().toISOString() }) + '\n');

/** Whether the saved row still names the process now running as `row.pid`, and belongs to the run whose scratch is `scratch`. */
export const proves = (row, scratch) => typeof row.start === 'string' && row.boot === bootId() && bootId() !== null && row.runId === basename(scratch) && processStart(row.pid) === row.start;
