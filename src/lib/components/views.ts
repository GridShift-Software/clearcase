import { versionPath } from '../local-case/model.ts';
import { CATEGORIES, VIEWS, VIEW_GROUPS, type ViewCategory, type ViewEntry } from './view-registry.ts';

export { CATEGORIES, VIEWS, VIEW_GROUPS, type ViewCategory, type ViewEntry };

export const viewHref = (resultsVersion: string, v: Pick<ViewEntry, 'route'>, base?: string) => `${versionPath(resultsVersion, base)}${v.route}`;
export const viewById = (id: string) => VIEWS.find((v) => v.id === id);
export const viewAt = (category: string, id: string) => VIEWS.find((v) => v.category === category && v.id === id);
export const isAvailable = (v: Pick<ViewEntry, 'status'>) => v.status === 'available';
export const blockedBy = (v: Pick<ViewEntry, 'status'>) => (v.status.startsWith('unavailable-until:') ? v.status.slice('unavailable-until:'.length) : null);
export const grouped = (): { group: string; views: ViewEntry[] }[] => VIEW_GROUPS.map((group) => ({ group, views: VIEWS.filter((v) => v.group === group) }));
