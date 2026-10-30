// Native exact-version sign-off and publication (ADR-0010). Parent-facing surface: ports, the D1 ledger, the controller
// and the composition point. Hosted-safe: Web Crypto and the runtime contracts only, no Node built-in, no filesystem.
export type * from './ports.ts';
export { createNativePublication, type PublicationController, type PublicationRequest } from './controller.ts';
export { d1PublicationLedger, type PublicationD1, type PublicationD1Statement, type PublicationD1Value, type PublicationLedgerOptions } from './ledger.ts';
export type { OriginalHead, OriginalsComparison, PublicationEvidence } from './signoff-evidence.ts';
export { OriginalsEvidenceError, createOriginalsProducer, originalRefs, r2OriginalsComparison, type OriginalRef, type OriginalsProducerOptions } from './originals-evidence.ts';
export { publicationControllerFor, setPublicationComposition, type PublicationComposition } from './composition.ts';
