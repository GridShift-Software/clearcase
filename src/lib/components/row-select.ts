const CONTROLS = 'a, button, input, select, textarea, label, summary';
/** Whether a click on `target` inside a row selects the row: anywhere but a control (a link, the Preview button, a field), which keeps its own behaviour. */
export const selectsRow = (target: EventTarget | null) => !!target && typeof (target as Element).closest === 'function' && !(target as Element).closest(CONTROLS);
