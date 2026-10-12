// Discovery Schedule view state that outlives one visit, as v5's module-level ST does (S-discovery_tab-5, low, copied):
// the schedule/bundle sub-view, the filter text and the only-unmatched flag survive navigating away and back within
// the session, and are lost on reload. The mode is user work (stored).
export const ds = $state({ view: 'schedule' as 'schedule' | 'bundle', q: '', onlyMissing: false });
