// The entry the intake contract tests drive. At this commit no intake route or submissions module exists, so every
// request reaches the hosted entry's existing fallback for unmigrated routes (deploy/client/routes/[...path]), exactly
// what a deployed Worker answers today. The adverse assertions therefore fail on their expected answers, not on a missing
// module. The implementation commit points this file at the real route modules and composition.
import * as fallback from '../../../deploy/client/routes/[...path]/+server.ts';

export const MIGRATIONS: readonly string[] = [];
export type Route = 'submissions' | 'submission';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }

/** Installs the intake ports the parent composition would install; there is no composition point yet. */
export function compose(_ports: unknown): void {}
export function repositoryFor(_db: unknown): unknown { return null; }
export async function dispatch(_route: Route, method: 'GET' | 'POST' | 'PUT', _event: RouteEvent): Promise<Response> {
  return fallback[method]();
}
