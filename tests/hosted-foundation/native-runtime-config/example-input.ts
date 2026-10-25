// EXPLICIT SYNTHETIC EXAMPLE, not a deploy preset. Every hostname is a .test name, every identifier is invented here, every
// publishable key is derived at run time from a synthetic Frontend API host, and every number is a unit-test bound chosen to
// exercise the validators' relations. Nothing names a real provider resource, Clerk instance, tenant or production policy.
export type Example = ReturnType<typeof exampleInput>;

const publishable = (host: string) => ['pk', 'test', Buffer.from(`${host}$`).toString('base64')].join('_');
export const SYNTHETIC_STAFF_HOST = 'staff.clerk.test';
export const SYNTHETIC_CLIENT_IDS = ['client-a', 'client-b'] as const;

const resources = (slot: 'a' | 'b') => ({
	clientId: `client-${slot}`, hostname: `client-${slot}.clearcase.test`, worker: `syn-client-${slot}`,
	d1DatabaseId: `${slot === 'a' ? '11111111' : '22222222'}-1111-4111-8111-111111111111`, d1DatabaseName: `syn-client-${slot}-db`, r2Bucket: `syn-client-${slot}-files`,
});
const policy = (render: Record<string, number> | null) => ({
	auditLimits: { maxEventBytes: 4096, maxRows: 1000, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 10, maxPageRows: 20, maxPagesPerRequest: 5 },
	storageBudgets: { maxPackageFiles: 64, maxPackageFileBytes: 1 << 20, maxPackageBytes: 4 << 20, maxDocuments: 1000, maxRowsPerBatch: 3, maxBufferedObjectBytes: 1 << 20,
		maxOriginalBytes: 1 << 20, maxVerifyObjects: 256, maxVerifyBytes: 16 << 20, maxVerifyObjectsPerCaseWindow: 4096, maxVerifyBytesPerCaseWindow: 256 << 20, verifyWindowSeconds: 3600 },
	storageQuotas: { maxUploadsPerCase: 50, maxOriginalBytesPerCase: 64 << 20, maxOriginalBytesPerClient: 256 << 20, maxPutAttemptsPerUpload: 5,
		maxVersionsPerCase: 20, maxPackageBytesPerCase: 64 << 20, maxPackageBytesPerClient: 256 << 20, maxStagingAttemptsPerCase: 50 },
	userWorkLimits: { maxStatementsPerBatch: 20, maxSnapshotBytes: 1 << 20 },
	intakeBudget: { maxFileBytes: 1 << 20, maxMetadataBytes: 4096 },
	importBudget: { maxRequestBytes: 16 << 20, maxFiles: 64, maxFileBytes: 1 << 20, maxPackageBytes: 4 << 20 },
	nativeRenderBudget: render,
});
const client = (slot: 'a' | 'b', render: Record<string, number> | null) => ({
	deployment: resources(slot), appOrigin: `https://client-${slot}.clearcase.test`,
	clerk: { clientPublishableKey: publishable(`client-${slot}.clerk.test`), staffPublishableKey: publishable(SYNTHETIC_STAFF_HOST), apiUrl: null,
		signInUrl: `https://client-${slot}.clerk.test/sign-in`, staffSignInUrl: `https://${SYNTHETIC_STAFF_HOST}/sign-in`, audience: null, mfaRequired: false },
	policy: policy(render),
});

/** A fresh mutable object per call. Client A opts in to Browser with two runs a day; client B has no render budget. */
export function exampleInput() {
	return {
		manifest: {
			staffIssuer: `https://${SYNTHETIC_STAFF_HOST}`,
			clients: (['a', 'b'] as const).map((slot) => ({ ...resources(slot), clientIssuer: `https://client-${slot}.clerk.test` })),
		},
		clients: [
			client('a', { maxFileBytes: 1_000_000, maxPages: 4, maxCanvasPixels: 1_000_000, maxRunMs: 10_000, maxRunsPerCasePerDay: 1, maxRunsPerClientPerDay: 2 }),
			client('b', null),
		],
		browserAllocation: null as null | { maxConcurrentBrowsers: number; maxReservedBrowserMsPerDay: number },
	};
}
/** The example with both clients opted in and an explicit aggregate policy that exactly fits their worst case. */
export function exampleWithBrowserAllocation() {
	const input = exampleInput();
	input.clients[1]!.policy.nativeRenderBudget = { maxFileBytes: 2_000_000, maxPages: 8, maxCanvasPixels: 2_000_000, maxRunMs: 5_000, maxRunsPerCasePerDay: 1, maxRunsPerClientPerDay: 1 };
	// A: 2 runs x (10_000 + 2_000 + 60_000) = 144_000; B: 1 run x (5_000 + 2_000 + 60_000) = 67_000.
	input.browserAllocation = { maxConcurrentBrowsers: 2, maxReservedBrowserMsPerDay: 211_000 };
	return input;
}
