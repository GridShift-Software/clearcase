// Apply ClearCase prohibitions, then use the installed plugin's canonical grammar/catalogue validator.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

try {
  const [sheetPath, catalogPath, validatorPath, modelsPath] = process.argv.slice(2);
  const { parseSheet, parseEntry, checkSheet } = await import(pathToFileURL(validatorPath).href);
  const sheet = parseSheet(readFileSync(sheetPath, 'utf8'));
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const { roles, tiers } = JSON.parse(readFileSync(modelsPath, 'utf8'));
  if (typeof catalog.capturedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(catalog.capturedAt)) {
    throw Error('catalogue capturedAt must be an ISO timestamp with a UTC offset');
  }
  const captured = Date.parse(catalog.capturedAt);
  const age = Date.now() - captured;
  if (!Number.isFinite(captured) || age < -300_000 || age > 3_600_000 || !Array.isArray(catalog.providers)) {
    throw Error('catalogue requires capturedAt within the last hour and a providers list (future tolerance: 5 minutes)');
  }
  const problems = [];
  const entries = [...sheet.filter(row => row.key !== 'session hook').map(row => row.value ?? ''), ...Object.values(tiers).flat()];
  for (const text of entries) {
    for (const entryText of text.split(',')) {
      const entry = parseEntry(entryText);
      if (!entry) { problems.push('inherit-parent/auto cannot establish an explicit model and effort'); continue; }
      if (/ultracode/i.test(entry.providerInstanceId + '/' + entry.model)) problems.push('ultracode is forbidden');
      if (Object.entries(entry.options).some(([key, value]) => /effort/i.test(key) && value.toLowerCase() === 'max')) {
        problems.push('effort max is forbidden');
      }
    }
  }
  problems.push(...checkSheet(sheet, { roles, defaults: tiers, catalog }));
  if (problems.length) throw Error(problems.join('; '));
  console.log('model-sheet: PASS. Canonical sheet/catalogue validation; no settings changed.');
} catch (error) {
  console.error(`model-sheet: FAIL. ${error.message}`);
  process.exitCode = 1;
}
