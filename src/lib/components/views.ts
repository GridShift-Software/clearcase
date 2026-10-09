// Navigation contract over the generated 42-entry registry. Browser-safe.
import { versionPath } from '../local-case/model.ts';
import { CATEGORIES, VIEWS, VIEW_GROUPS, type ViewCategory, type ViewEntry } from './view-registry.ts';

export { CATEGORIES, VIEWS, VIEW_GROUPS, type ViewCategory, type ViewEntry };

/** Absolute app path of a view within one results version. */
export const viewHref = (resultsVersion: string, v: Pick<ViewEntry, 'route'>) => `${versionPath(resultsVersion)}${v.route}`;
export const viewById = (id: string) => VIEWS.find((v) => v.id === id);
/** The registry entry served at /v/[vid]/<category>/<view>, if any. */
export const viewAt = (category: string, id: string) => VIEWS.find((v) => v.category === category && v.id === id);
export const isAvailable = (v: Pick<ViewEntry, 'status'>) => v.status === 'available';
/** 'GRS-15' for an unavailable entry, null when available. */
export const blockedBy = (v: Pick<ViewEntry, 'status'>) => (v.status.startsWith('unavailable-until:') ? v.status.slice('unavailable-until:'.length) : null);
export const grouped = (): { group: string; views: ViewEntry[] }[] => VIEW_GROUPS.map((group) => ({ group, views: VIEWS.filter((v) => v.group === group) }));
