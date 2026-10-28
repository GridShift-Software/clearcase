// The shell's case actions on hosted: links that stay in the case. Ticket 19 adds the intake link here.
import type { ShellData } from '../../components/shell.ts';
import { notesHref } from './paths.ts';

export const caseActions = (caseId: string): ShellData['actions'] => [
  { label: '← All cases', href: '/cases' },
  { label: 'Notes', href: notesHref(caseId) },
];
