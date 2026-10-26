-- GRS-114: explicit case and grant-management grants of one client instance. Owned by src/lib/tenancy only.
-- Case existence is asked through an injected CaseDirectory port (GRS-115 storage), so there is no foreign key to a
-- case table here. client_id is kept on every row and every query, so a row of another client never answers.
CREATE TABLE IF NOT EXISTS tenant_case_grants (
  grant_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('case', 'client')),
  case_id TEXT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) > 0),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('client', 'staff')),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'operator', 'publisher', 'grant-admin')),
  slot TEXT NOT NULL CHECK (slot IN ('content', 'operator', 'publisher', 'grant-admin')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  expires_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  created_by_issuer TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes TEXT,
  revoked_operation_id TEXT,
  revoked_at TEXT,
  CHECK ((scope = 'case') = (case_id IS NOT NULL)),
  CHECK ((scope = 'client') = (role = 'grant-admin')),
  CHECK (slot = CASE WHEN role IN ('viewer', 'editor') THEN 'content' ELSE role END),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
-- One live (pending or active) grant per principal, scope and slot; a pending create holds its slot.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_live ON tenant_case_grants (client_id, scope, ifnull(case_id, ''), issuer, subject, slot) WHERE state <> 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_created_op ON tenant_case_grants (client_id, created_operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_case_grants_revoked_op ON tenant_case_grants (client_id, revoked_operation_id) WHERE revoked_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_case_grants_principal ON tenant_case_grants (client_id, issuer, subject, scope, case_id);
