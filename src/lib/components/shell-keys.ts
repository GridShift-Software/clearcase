type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Ctrl+K (Cmd+K on a Mac) moves focus to the search box; with Alt or Shift held it is some other shortcut. */
export const isSearchShortcut = (e: KeyEventLike): boolean => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
