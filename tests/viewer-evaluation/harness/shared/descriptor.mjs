// The one descriptor validator. The trusted shell calls it before it creates a frame, and every reader calls it again on
// what it receives, so neither trusts the other. It returns the path of every field that is missing, null where null is
// not allowed, retyped, outside its enum, or inconsistent with its role. Pure JavaScript for the browser and Bun.
export const SCHEMA = 'clearcase.viewer-descriptor/1';
export const FAMILIES = ['pdf', 'image', 'word', 'sheet', 'email', 'media', 'archive', 'text'];
export const ROLES = ['original', 'child', 'rendition', 'supplement'];
export const RENDITION_KINDS = ['pdf', 'page-image', 'ocr-text', 'captions', 'body-text'];

const str = (v) => typeof v === 'string';
const int = (v, min = 0) => Number.isInteger(v) && v >= min;
const hex = (v) => str(v) && /^[0-9a-f]{64}$/.test(v);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const orNull = (ok) => (v) => v === null || ok(v);
const every = (v, ok) => Array.isArray(v) && v.every(ok);

function mapping(m) {
  if (!obj(m)) return false;
  if (m.kind === 'none') return true;
  return m.kind === 'verified' && obj(m.pages) && Object.entries(m.pages).every(([k, p]) => /^[1-9][0-9]*$/.test(k) && int(p, 1));
}

function child(c) {
  if (!obj(c) || !str(c.key)) return false;
  if (c.kind === 'attachment') return str(c.assetId) && c.assetId !== '' && orNull(str)(c.name) && str(c.mime) && orNull(str)(c.declaredMime) && hex(c.sha256) && orNull(str)(c.contentId) && typeof c.inline === 'boolean' && typeof c.embeddedMessage === 'boolean';
  if (c.kind !== 'member' || !str(c.path) || typeof c.directory !== 'boolean' || typeof c.duplicateName !== 'boolean' || !every(c.problems, str)) return false;
  if (c.assetId === null) return c.mime === null && c.family === null && c.sha256 === null && c.size === null && (c.directory || c.problems.length > 0);
  return str(c.assetId) && c.assetId !== '' && str(c.mime) && str(c.family) && hex(c.sha256) && int(c.size) && c.directory === false && c.problems.length === 0;
}

/** Paths of the invalid fields of a descriptor; an empty array means it is exactly the schema. */
export function invalidFields(d) {
  if (!obj(d)) return ['(descriptor)'];
  const bad = [];
  const check = (path, ok) => { if (!ok) bad.push(path); };
  check('schema', d.schema === SCHEMA);
  check('assetId', str(d.assetId) && d.assetId !== '');
  check('name', str(d.name));
  check('family', FAMILIES.includes(d.family) || d.family === 'unknown');
  check('mime', str(d.mime));
  check('variant', orNull(str)(d.variant));
  check('size', int(d.size));
  check('sha256', hex(d.sha256));
  check('role', ROLES.includes(d.role));
  check('original', orNull((o) => obj(o) && str(o.assetId) && o.assetId !== '' && hex(o.sha256))(d.original));
  check('rendition', orNull((r) => obj(r) && int(r.version, 1) && orNull((p) => int(p, 1))(r.page) && mapping(r.mapping))(d.rendition));
  check('renditions', every(d.renditions, (r) => obj(r) && str(r.assetId) && r.assetId !== '' && RENDITION_KINDS.includes(r.kind) && int(r.version, 1) && orNull((p) => int(p, 1))(r.page) && hex(r.sha256) && ['rendition', 'supplement'].includes(r.role)));
  check('children', every(d.children, child));
  check('parent', orNull((p) => obj(p) && str(p.assetId) && p.assetId !== '' && str(p.key))(d.parent));
  check('visualParts', every(d.visualParts, str));
  check('pages', orNull((p) => int(p, 1))(d.pages));
  check('native', typeof d.native === 'boolean');
  check('limits', obj(d.limits) && obj(d.limits.zip) && ['maxEntries', 'maxEntryBytes', 'maxTotalBytes', 'maxDepth'].every((k) => int(d.limits.zip[k])));
  check('holds', every(d.holds, (h) => obj(h) && str(h.code) && h.code !== '' && str(h.detail)));
  // a role fixes which links exist: only renditions and supplements point back at an original, only children have a parent
  const linked = d.role === 'rendition' || d.role === 'supplement';
  if (ROLES.includes(d.role)) {
    check('original', (d.original !== null) === linked || bad.includes('original'));
    check('rendition', (d.rendition !== null) === linked || bad.includes('rendition'));
    check('parent', (d.parent !== null) === (d.role === 'child') || bad.includes('parent'));
  }
  return [...new Set(bad)];
}
