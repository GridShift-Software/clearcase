// `doc/<ref>.json` (one `DocShard` per document: the document page without original links and notes) and
// `documents/default.json` (the documents list as the unfiltered request answers it). Both mirror the local loaders
// they replace: src/routes/v/[vid]/doc/[ref]/+page.server.ts and src/routes/v/[vid]/evidence/documents/+page.server.ts.
import type { AttachmentRow, ChronologyListRow, DocumentStateRow } from '../../../src/lib/local-case/model.ts';
import { documentsModel } from '../../../src/lib/views/evidence/documents.ts';
import type { DocumentsDefaultShard } from '../../../src/lib/views/payloads/documents.ts';
import type { DocShard, OriginalState } from '../../../src/lib/views/payloads/doc.ts';
import type { ShardModule } from '../types.ts';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** How the document's own original can be opened, from the importer's state row. */
export function originalStateOf(state: DocumentStateRow): OriginalState {
  if (state.file === 'present' && state.original) return 'available';
  if (state.self?.route === 'parent' || state.flags.includes('embedded')) return 'embedded';
  return 'missing';
}

export default {
  name: 'doc',
  async build({ store, resultsVersion: rv, json }) {
    const { documents } = store.projectionRows(rv);
    const shards = documents.map((d) => {
      const row = JSON.parse(d.row_json) as Record<string, unknown>;
      const state = JSON.parse(d.state_json) as DocumentStateRow;
      const atts = JSON.parse(d.attachments_json) as AttachmentRow[];
      const refs = Array.isArray(row.refs) ? row.refs.map(str) : [];
      const parentRef = state.self?.parentRef ?? (typeof row.pr === 'string' ? row.pr : null);
      const existing = store.existingRefs(rv, [...new Set([...atts.map((x) => x.key), ...refs, ...(parentRef ? [parentRef] : [])])]);
      const originalState = originalStateOf(state);
      const shard: DocShard = {
        ref: d.ref,
        source: 'results',
        fields: {
          date: str(row.date), dateType: typeof row.date_type === 'string' ? row.date_type : null, dateSource: typeof row.date_source === 'string' ? row.date_source : null,
          subject: str(row.subject), filename: str(row.filename), docType: str(row.doc_type), bundle: str(row.bundle), sender: str(row.sender), to: str(row.to), cc: str(row.cc),
          amount: str(row.amount), invoiceNo: str(row.invoice_no), size: typeof row.size === 'number' ? row.size : null, textStatus: str(row.text_status),
          alsoIn: Array.isArray(row.also_in) ? row.also_in.map(str) : [], attachmentNames: Array.isArray(row.attachments) ? row.attachments.map(str) : [], excerpt: str(row.excerpt),
        },
        state,
        attachments: atts.map((x) => ({ ...x, hasDocument: existing.has(x.key) })),
        children: store.childDocuments(rv, d.ref).map((c) => c.ref),
        related: refs.map((r) => ({ ref: r, exists: existing.has(r) })),
        parent: parentRef ? { ref: parentRef, exists: existing.has(parentRef) } : null,
        assetIds: { own: originalState === 'available' ? d.ref : null, attachments: atts.filter((x) => x.route === 'direct').map((x) => x.key) },
        mediaType: state.original?.mediaType ?? state.mediaType,
        originalState,
      };
      return json(`doc/${d.ref}.json`, shard);
    });
    const rows = JSON.parse(store.chronologyJson(rv)!) as ChronologyListRow[];
    const initial: DocumentsDefaultShard = { total: rows.length, model: documentsModel(rows, { bundle: null, q: '', page: null }) };
    return [...shards, json('documents/default.json', initial)];
  },
} satisfies ShardModule;
