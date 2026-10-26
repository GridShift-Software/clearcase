// Test-only helpers. The crafted Clerk instances are made per run (identity/synthetic.ts); their secret and JWT values exist only
// in memory here, to prove the planner's emitted values are accepted by the real parsers. None is ever passed to the planner.
import { CLERK_ENV } from '../../../src/lib/auth/clerk/config.ts';
import { planNativeRuntimeConfig, NATIVE_RUNTIME_CONFIG_VAR, nativeRuntimeConfigDiagnostic } from '../../../deploy/native-alpha/runtime-config.ts';
import { craftedInstance } from '../identity/synthetic.ts';
import { SYNTHETIC_STAFF_HOST } from './example-input.ts';

export const instances = {
	'client-a': craftedInstance('client-a.clerk.test'),
	'client-b': craftedInstance('client-b.clerk.test'),
	staff: craftedInstance(SYNTHETIC_STAFF_HOST),
};
type ClientFile = ReturnType<typeof planNativeRuntimeConfig>['clients'][number];

/** The emitted vars plus the secret bindings the file names, with the synthetic values a parent would supply out of band. */
export function runtimeEnv(file: ClientFile, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const own = instances[file.clientId as 'client-a' | 'client-b'];
	const values: Record<string, string> = {
		[CLERK_ENV.client.secretKey]: own.secretKey, [CLERK_ENV.client.jwtKey]: own.jwtKey,
		[CLERK_ENV.staff.secretKey]: instances.staff.secretKey, [CLERK_ENV.staff.jwtKey]: instances.staff.jwtKey,
	};
	return { ...file.vars, ...Object.fromEntries(file.secrets.map((name) => [name, values[name]])), ...extra };
}
export const nativeConfigOf = (file: ClientFile) => JSON.parse(file.vars[NATIVE_RUNTIME_CONFIG_VAR]!) as Record<string, unknown>;

/** The fixed refusal text of a rejected input, or fails the test when it was accepted or the error was not this module's. */
export function refusalOf(input: unknown): string {
	try {
		planNativeRuntimeConfig(input);
	} catch (error) {
		const message = nativeRuntimeConfigDiagnostic(error);
		if (message === undefined) throw new Error('refusal was not issued by the planner');
		return message;
	}
	throw new Error('input was accepted');
}
