// The shell's case actions on hosted: links that stay in the case. Ticket 19 adds the intake link here.
import type { ShellData } from '../../components/shell.ts';
import { notesHref } from './paths.ts';
import type { RequestEvent } from '@sveltejs/kit';
import { intakeActionAvailable } from '../../submissions/composition.ts';
import { id } from '../../server/runtime/ids.ts';

export const caseActions = (caseId: string, canUpload = false): ShellData['actions'] => [
  { label: '← All cases', href: '/cases' },
  { label: 'Notes', href: notesHref(caseId) },
  ...(canUpload ? [{ label: 'Upload documents', href: `/client/intake/${encodeURIComponent(caseId)}` }] : []),
];

/** The layout calls this only after publishedVersion/shard admit its reader. */
export async function caseActionsFor(caseId: string, event: RequestEvent): Promise<ShellData['actions']> {
  return caseActions(caseId, await intakeActionAvailable(event, event.locals.identity, id('case', caseId)));
}
