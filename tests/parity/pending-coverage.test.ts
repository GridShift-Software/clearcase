import { expect, it } from 'vitest';
import { covering } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister, registryKeys, registryOwners } from '../../scripts/parity/lib/register.mjs';

const register = loadRegister(undefined, { owners: await registryOwners(), keys: await registryKeys() });

it('an unexpected restore input in a synthetic backup form is not an approved difference', () => {
	expect(register.problems).toEqual([]);
	const difference = {
		path: 'control.input:text:Unexpected restore bypass',
		kind: 'app-only',
		v5: '<absent>',
		app: '1',
	};
	expect(covering(register.entries, 'backup_tab', difference)).toBeNull();
});
