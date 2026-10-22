import Type, { type TSchema } from 'typebox';

const Str = Type.String();
const Int = Type.Integer();
const Count = Type.Integer({ minimum: 0 });
const Bool = Type.Boolean();
const StrArr = Type.Array(Str);
const IsoDateOrEmpty = Type.String({ pattern: '^(?:\\d{4}-\\d{2}-\\d{2})?$' });
const Amount = Type.String({ pattern: '^(?:-?\\d{1,15}(?:\\.\\d{1,4})?)?$' });
const Obj = (props: Record<string, TSchema>) => Type.Object(props);
const Rec = (value: TSchema) => Type.Record(Type.String(), value);
const NumOrStr = Type.Union([Str, Int]);

export const V5Chronology = Type.Array(Obj({
  ref: Str,
  n: NumOrStr,
  seq: NumOrStr,
  date: IsoDateOrEmpty,
  filename: Str,
  subject: Str,
  sender: Str,
  to: Str,
  cc: Str,
  excerpt: Str,
  doc_type: Str,
  bundle: Str,
  amount: Amount,
  also_in: StrArr,
  text_status: Str,
  url: Str,
  refs: StrArr,
  invoice_no: Str,
  size: Count,
  attachments: StrArr,
  /** newer export: parent ref of an extracted attachment row */
  pr: Type.Optional(Str),
  /** newer export: where the date was read from (filename, header, text, file, ocr) */
  date_source: Type.Optional(Str),
}));

export const V5People = Type.Array(Obj({ name: Str, email: Str, org: Str, sent: Count, received: Count, total: Count, role: Str }));
export const V5Entities = Type.Array(Obj({ name: Str, note: Str, role: Str }));
const Heading = Obj({ h: Str, t: Str });
export const V5Matter = Obj({ title: Str, short: Str, forum: Str, storyline: Type.Array(Heading), strategy: Type.Array(Heading) });

const SeriesRow = Obj({ amount: Amount, date: IsoDateOrEmpty, filename: Str, ref: Str, url: Str });
export const V5Quantum = Obj({
  amountDueSeries: Type.Array(SeriesRow),
  statementSeries: Type.Array(SeriesRow),
  interestSeries: Type.Array(SeriesRow),
  invoiceLedger: Type.Array(Obj({ amount: Amount, bundle: Str, date: IsoDateOrEmpty, no: Str, ref: Str, text_status: Str, url: Str })),
  chargingCount: Count,
  invoiceCount: Count,
  grossInvoiced: Amount,
  headline_date: IsoDateOrEmpty,
  headline_due: Amount,
  headline_ref: Str,
  headline_url: Str,
});

export const V5RiskMatrix = Type.Array(Obj({
  issue: Str, likelihood: Str, impact: Str, mitigation: Str,
  /** newer builder (the JSON script's `type`): the risk's category, its owner and the documents it cites */
  category: Type.Optional(Str), owner: Type.Optional(Str), refs: Type.Optional(StrArr),
}));
const DocLink = Obj({ date: IsoDateOrEmpty, doc_type: Str, filename: Str, ref: Str, url: Str });
export const V5DefenceMatrix = Type.Array(Obj({ point: Str, dcs: Str, rebuttal: Str, evidence: Str, refs: Str, docs: Type.Array(DocLink) }));
export const V5InfoRequired = Type.Array(Obj({ item: Str, owner: Str, status: Str }));
export const V5Witnesses = Type.Array(Obj({ name: Str, role: Str, willsay: Str }));
const BuildRow = Obj({ bundle: Str, filename: Str, ref: Str });
export const V5BuildReport = Obj({ generatedFrom: Str, pending: Type.Array(BuildRow), textNone: Type.Array(BuildRow) });
export const V5LinkSample = Type.Array(Obj({ bundle: Str, filename: Str, ref: Str, url: Str }));
export const V5TimelineEvents = Type.Array(Obj({ date: IsoDateOrEmpty, kind: Str, note: Str, ref: Str, title: Str, url: Str, phase: Type.Optional(Str), refs: Type.Optional(StrArr) }));
export const DatePhase = Type.Object({ key: Type.String({ minLength: 1 }), title: Str, from: IsoDateOrEmpty, to: IsoDateOrEmpty, summary: Str, oneLine: Type.Optional(Str) });
// Keep the two generations distinct: date-phase membership comes from event.phase, never its year.
export const V5TimelinePhases = Type.Union([Type.Array(StrArr), Type.Array(DatePhase)]);
export const AnalysisAnchor = Type.Object({ ref: Str, issue: Str, why: Str, rank: Type.Optional(Count), page: Type.Optional(Type.Integer({ minimum: 1 })), quote: Type.Optional(Str), title: Type.Optional(Str), date: Type.Optional(IsoDateOrEmpty) });
export const AnalysisAnchors = Type.Array(AnalysisAnchor);
export const Organogram = Type.Object({
  nodes: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Str, kind: Type.Optional(Str), side: Type.Optional(Str), role: Type.Optional(Str), refs: Type.Optional(StrArr) })),
  edges: Type.Array(Type.Object({ from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }), label: Type.Optional(Str), type: Type.Optional(Str), refs: Type.Optional(StrArr) })),
});
export const V5TimelineYearCounts = Rec(Count);
export const V5TimelineTypeByYear = Rec(Rec(Count));
const RegisterItem = Obj({ date: IsoDateOrEmpty, doc_type: Str, note: Str, party: Str, ref: Str, role: Str, text_status: Str, title: Str, url: Str });
export const V5Contracts = Obj({ count: Count, groups: Type.Array(Obj({ key: Str, items: Type.Array(RegisterItem) })) });
export const V5Filings = Obj({
  count: Count,
  groups: Type.Array(Obj({ key: Str, note: Str, items: Type.Array(RegisterItem) })),
  /** imported seed rows for the filings register; user edits are overlays keyed by seed id */
  registerSeed: Type.Array(Obj({ fdate: Str, filing: Str, fparty: Str, rdate: Str, ref: Str, response: Str, status: Str })),
});
export const V5Contradictions = Obj({
  byCat: Rec(Count),
  categories: Type.Array(Obj({
    key: Str, title: Str, severity: Str, explain: Str,
    items: Type.Array(Obj({
      label: Str, detail: Str,
      rates: Type.Optional(Rec(Str)),
      spread: Type.Optional(Str),
      refs: Type.Array(Obj({ amount: Amount, filename: Str, ref: Str, url: Str })),
    })),
  })),
  checks: Type.Array(Obj({ check: Str, n: Count, result: Str })),
  /** Newer checks retain their original shape, without a fabricated count. */
  source_checks: Type.Optional(Type.Array(Obj({ check: Str, result: Str, n: Type.Optional(Count) }))),
  highCount: Count,
  total: Count,
});
export const V5LitEnforcement = Type.Array(Obj({ phase: Str, step: Str, basis: Str, status: Str, note: Str }));
export const V5LitLegality = Obj({
  intro: Str,
  docs: Type.Array(Obj({ date: IsoDateOrEmpty, ref: Str, title: Str, url: Str })),
  factors: Type.Array(Obj({ factor: Str, note: Str })),
  scenarios: Type.Array(Obj({ scenario: Str, prob: Str, effect: Str, action: Str })),
});
export const V5LitAuthorities = Type.Array(Obj({ topic: Str, authority: Str, proposition: Str }));
export const V5LitElements = Type.Array(Obj({ element: Str, must: Str, evidence: Str, witness: Str, tab: Str }));
export const V5LitCrossexamSeed = Type.Array(Obj({ witness: Str, topic: Str, put: Str, docs: Str }));
export const V5LitPrescription = Type.Array(Obj({ no: Str, ref: Str, date: IsoDateOrEmpty, prescDate: IsoDateOrEmpty, risk: Str, url: Str }));
export const V5LitPrescSummary = Obj({ awardDate: IsoDateOrEmpty, note: Str, reliesOnInterruption: Count, total: Count });
export const V5LitInterestBasis = Obj({ award_date: IsoDateOrEmpty, first_invoice_date: IsoDateOrEmpty, headline_date: IsoDateOrEmpty, headline_due: Amount, note: Str });
export const V5LitRecon = Type.Array(Obj({ month: Str, invoice: StrArr, statement: StrArr, supporting: StrArr, charging: StrArr, amountdue: StrArr, pod: StrArr }));
export const V5LitSettlement = Obj({ claim: Amount, claimDate: IsoDateOrEmpty });

const CaselinesRange = Obj({ from: Count, to: Count, basis: Str, confidence: Str, stamps: Str });
const Part = Obj({ name: Str, rel: Str, url: Str, from: Count, to: Count, n: Type.Optional(Count), whole: Type.Optional(Bool) });
export const V5Bundles = Obj({
  source: Str,
  indexSource: Str,
  folder: Str,
  extracts: Str,
  caselinesSrc: Str,
  count: Count,
  catCount: Count,
  totalDocs: Count,
  totalItems: Count,
  totalPages: Count,
  headerDefaults: Obj({ caseNo: Str, claimant: Str, claimantRole: Str, court: Str, defendant: Str, defendantRole: Str, intro: Str, judge: Str }),
  caselinesSections: Rec(Obj({ from: Count, to: Count, title: Str })),
  /** court-bundle item keys are their own namespace (e.g. OD-10), never chronology refs */
  catalogue: Rec(Obj({
    key: Str, item: Count, src: Str, srcName: Str, co: Str, date: Str, desc: Str,
    missing: Bool, nDocs: Count, pages: Count,
    docs: Type.Array(Obj({ ref: Str, name: Str, ext: Str, pages: Count, url: Str, from: Type.Optional(Count), to: Type.Optional(Count) })),
    parts: Type.Array(Part),
    blank: Type.Optional(Bool),
    needsExtent: Type.Optional(Bool),
    review: Type.Optional(Bool),
    caselines: Type.Optional(Type.Union([Type.Null(), CaselinesRange])),
  })),
  list: Type.Array(Obj({
    no: Str, name: Str, slug: Str, title: Str, note: Str,
    file: Str, indexFile: Str, planFile: Str,
    pages: Count, bundlePages: Count, filePages: Count, indexPages: Count,
    nDocs: Count, nItems: Count, nMissing: Count, nNeedsExtent: Count, nReview: Count,
    items: StrArr,
    rows: Type.Array(Obj({
      key: Str, n: Count, desc: Str, from: Count, to: Count, pages: Count, parts: Type.Array(Part),
      co: Type.Optional(Str), date: Type.Optional(Str), blank: Type.Optional(Bool),
      slice: Type.Optional(Str), sliceUrl: Type.Optional(Str), caselines: Type.Optional(CaselinesRange),
    })),
  })),
});

export const V5Meta = Obj({
  builtAt: Str,
  docCount: Count,
  dataFolderName: Str,
  bundles: Rec(Count),
  emails: Count,
  invoices: Count,
  people: Count,
  textNone: Count,
  textPending: Count,
  dateSpan: Type.Array(Str, { maxItems: 2 }),
  docTypes: Rec(Count),
});

const SchedRow = Obj({ no: Count, date: Str, desc: Str, co: Str, nfiles: Count, files: Type.Array(Obj({ fn: Str, url: Str, co: Str, x: Type.Optional(Str) })) });
export const V5DiscoverySchedules = Obj({ discovery: Type.Array(SchedRow), supplementary: Type.Array(SchedRow) });

/** page-text index: [page number, page text] pairs (prefixItems, JSON Schema 2020-12) */
const PageText = Type.Unsafe<[number, string]>({ type: 'array', prefixItems: [{ type: 'integer', minimum: 0 }, { type: 'string' }], items: false, minItems: 2 });
export const V5CaselinesIndex = Obj({ file: Str, pages: Count, index: Type.Array(PageText) });

export const V5SourceLayout = Rec(StrArr);
export const V5ConversionReport = Obj({
  adapter: Obj({ name: Str, version: Str }),
  sourceLines: Rec(Count),
  ignoredCodeLiterals: StrArr,
  /** The detected workspace generation, written only for a generation other than v5 (v5's package bytes stay as they were). */
  source: Type.Optional(Obj({ generation: Str, builderVersion: Type.Optional(Str) })),
  diagnostics: Type.Array(Obj({ code: Str, subject: Type.Union([Str, Type.Null()]), message: Str })),
});
export const VIEW_ID = '^_?[a-z][a-z0-9_]{0,63}$';
export const VIEW_FIELD_ID = '^[a-z][A-Za-z0-9]{0,63}$';
export const V5ViewTemplate = Obj({ template: Type.Array(Type.Union([Str, Obj({ param: Type.String({ pattern: VIEW_FIELD_ID }) })]), { minItems: 1 }) });
export const V5ViewValue = Type.Union([Str, Type.Number(), StrArr, V5ViewTemplate]);
export const V5ViewContent = Type.Record(Type.String({ pattern: VIEW_ID }), Type.Record(Type.String({ pattern: VIEW_FIELD_ID }), V5ViewValue, { additionalProperties: false }), { additionalProperties: false });
export const Opaque = Type.Unknown();
