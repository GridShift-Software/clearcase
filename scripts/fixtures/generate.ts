#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { generateCorpus } from './synthetic/corpus.ts';

const usage = 'fixtures:generate --out <new external directory> [--seed <text>] [--documents <positive integer>] [--profile small|poc]';

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    out: { type: 'string' },
    seed: { type: 'string', default: '20261017' },
    documents: { type: 'string', default: '1689' },
    profile: { type: 'string', default: 'small' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write(usage + '\n');
  } else {
    if (!values.out?.trim()) throw new Error('--out is required');
    if (!values.seed.length) throw new Error('--seed must not be empty');
    const documents = Number(values.documents);
    if (!/^\d+$/.test(values.documents) || !Number.isSafeInteger(documents) || documents < 1) {
      throw new Error('--documents must be a positive safe integer');
    }
    const profile = values.profile;
    if (profile !== 'small' && profile !== 'poc') throw new Error('--profile must be small or poc');
    const summary = await generateCorpus({ out: values.out, seed: values.seed, documents, profile });
    const { originals: _originals, packageHashes: _hashes, conversionDiagnostics: _diagnostics, ...brief } = summary;
    process.stdout.write(JSON.stringify(brief) + '\n');
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
  process.exitCode = 1;
}
