// Shared identifier grammar only: no audit constructor, binding, requester or producer authority.
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const validEventId = (value: unknown): value is string => typeof value === 'string' && EVENT_ID.test(value);
export const validCaseId = (value: unknown): value is string => typeof value === 'string' && CASE_ID.test(value);
