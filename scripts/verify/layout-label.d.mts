export const analysisAdditionsFrom: (env: Record<string, string | undefined>) => boolean;
export const labelCheck: (v: { id: string; label: string }, id: { heading: string | null; title: string; nav: string | null }, additions: boolean) => { expected: string; ok: boolean };
export const serverEnv: (additions: boolean) => Record<string, string>;
