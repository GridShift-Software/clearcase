
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const LIMITS = {
  manifestBytes: 1 * MiB,
  fileBytes: 64 * MiB, // any listed file
  packageBytes: 512 * MiB, // all listed files together
  packageFiles: 1024, // including manifest.json
  datasets: 512,
  jsonDepth: 32, // nested containers
  stringChars: 1 * MiB, // UTF-16 units per JSON string
  objectKeys: 100_000,
  arrayItems: 1_000_000,
  jsonValues: 20_000_000, // values per file
  assets: 500_000,
  pathBytes: 1024, // UTF-8 bytes of a relative path
  segmentBytes: 255,
  pathSegments: 32,
  refChars: 32,
  parentDepth: 4, // attachment -> parent -> ... chain
  diagnosticsPerCode: 2_000, // further instances are counted, not listed
  // zip transport of the same layout
  archiveEntries: 1024,
  archiveEntryBytes: 64 * MiB,
  archiveTotalBytes: 512 * MiB,
  archiveRatio: 100, // per entry above archiveRatioFloor bytes
  archiveRatioFloor: 1 * MiB,
  archiveNameBytes: 1024,
  originalBytes: 8 * GiB,
  originalsTotalBytes: 32 * GiB, // unique files
  validationDeadlineMs: 120_000,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export function withLimits(overrides: Partial<Limits> | undefined): Limits {
  return { ...LIMITS, ...(overrides ?? {}) };
}
