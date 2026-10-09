// Types for overview.mjs (the app adapter's default export).
declare const adapter: {
	view: 'overview';
	extract(p: unknown, ctx: unknown): Promise<any>;
	sweeps: { seeded_user_work(p: unknown, ctx: unknown): Promise<Record<string, string>> };
};
export default adapter;
