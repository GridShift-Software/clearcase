// NATIVE24: the unchanged real nodejs_compat bundle (entry SHA256 69aff7aa...) is falsely refused at line 3709:
// ByteMarker2[ByteMarker2["Object"] = 8] = "Object". Write regressions before the fix. These are synthetic source
// strings through the real scanModule/uploadModuleProblems seam, not a runtime mock or a computed-import waiver.
import { describe, expect, test } from 'vitest';
import { uploadModuleProblems } from '../../../../deploy/native-alpha/pipeline.ts';
import { scanModule } from '../../../../deploy/probes/target.ts';

const COMPAT = ['nodejs_als', 'nodejs_compat'];
const HELPERS = `var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });`;
const forwarder = (extra: string, call = 'fwd("node:crypto");') => `${HELPERS}
${extra}
var fwd = __name((module_name) => import(module_name), "fwd");
${call}
export default {};
`;
const problems = (source: string, flags = COMPAT) => uploadModuleProblems(scanModule(source), 'artifact/cloudflare/_worker.js', flags);
// The real typebox enum shape, including its module-scope declaration and lazy initializer scope. Framework syntax
// only; the supplied parent artifact is checked separately, read only, rather than copied into Git.
const REAL_ENUM = `var ByteMarker, Accumulator;
function init_hash() {
  (function(ByteMarker2) {
    ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
    ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
    ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
    ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
    ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
    ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
    ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
    ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
    ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
    ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
    ByteMarker2[ByteMarker2["String"] = 10] = "String";
    ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
    ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
    ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
  })(ByteMarker || (ByteMarker = {}));
}
function read_marker() { return ByteMarker.Object; }`;
const BODY = 'ByteMarker2[ByteMarker2["Object"] = 8] = "Object";';
const iife = (argument: string, body = BODY) => `(function(ByteMarker2) { ${body} })(${argument});`;
const LOCAL_ENUM = `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})')}`;

describe('real-bundle local enum proof, without relaxing the dynamic-import proof', () => {
  test('the real benign Object enum member does not invalidate the intrinsic keep-names helper', () => {
    const source = forwarder(REAL_ENUM);
    expect(scanModule(source).dynamic).toEqual([expect.objectContaining({ via: 'forwarder', forwarder: 'fwd', calls: [expect.objectContaining({ specifier: 'node:crypto' })] })]);
    expect(problems(source)).toEqual([]);
  });
  test('a local enum member named defineProperty is also distinct from the intrinsic', () => {
    expect(problems(forwarder(LOCAL_ENUM.replaceAll('"Object"', '"defineProperty"')))).toEqual([]);
  });
  test('the proof is independent of the enum and parameter spelling', () => {
    expect(problems(forwarder(LOCAL_ENUM.replaceAll('ByteMarker2', 'Member').replaceAll('ByteMarker', 'Codes')))).toEqual([]);
  });
  test('a proven local enum does not waive the node:crypto compatibility flag', () => {
    const p = problems(forwarder(REAL_ENUM), ['nodejs_als']);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/node:crypto.*nodejs_compat/);
  });
  test.each([
    ['computed caller', 'fwd(location.hash);'],
    ['escaping forwarder', 'globalThis.leak = fwd;'],
    ['unknown host', 'fwd("node:fs");'],
    ['relative module', 'fwd("./chunk.js");'],
    ['template caller', 'fwd(`node:crypto`);'],
    ['alias caller', 'var alias = fwd; alias("node:crypto");'],
  ])('a proven local enum still refuses %s', (_name, call) => {
    expect(problems(forwarder(REAL_ENUM, call)).join('\n')).toMatch(/dynamic import/);
  });
});

// Each variant is written explicitly to ensure the positive enum rule cannot turn a receiver name or a familiar
// assignment shape into authority. All global/aliased-global receivers and ambiguous local bindings stay refused.
const adverse: [string, string][] = [
  ['direct globalThis receiver', iife('globalThis')],
  ['direct self receiver', iife('self')],
  ['direct Object receiver', iife('Object', BODY.replaceAll('"Object"', '"defineProperty"'))],
  ['globalThis.Object receiver', iife('globalThis.Object', BODY.replaceAll('"Object"', '"defineProperty"'))],
  ['self.Object receiver', iife('self.Object', BODY.replaceAll('"Object"', '"defineProperty"'))],
  ['global alias initializer', `var ByteMarker = globalThis; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['self alias initializer', `var ByteMarker = self; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['Object alias initializer', `var ByteMarker = Object; ${iife('ByteMarker || (ByteMarker = {})', BODY.replaceAll('"Object"', '"defineProperty"'))}`],
  ['alias chain', `var root = globalThis; var ByteMarker = root; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['global alias reassignment before', `var ByteMarker; ByteMarker = globalThis; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['global alias reassignment after', `${LOCAL_ENUM} ByteMarker = globalThis;`],
  ['destructured global alias', `var ByteMarker; [ByteMarker] = [globalThis]; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['conditional global alias', `var ByteMarker; ByteMarker ||= globalThis; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['shadowing parameter', `var ByteMarker; function init(ByteMarker) { ${iife('ByteMarker || (ByteMarker = {})')} } init(globalThis);`],
  ['shadowing catch binding', `var ByteMarker; try {} catch (ByteMarker) { ${iife('ByteMarker || (ByteMarker = {})')} }`],
  ['shadowing block binding', `var ByteMarker; { let ByteMarker = globalThis; ${iife('ByteMarker || (ByteMarker = {})')} }`],
  ['exported enum binding', `export var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})')}`],
  ['exported enum alias', `${LOCAL_ENUM} export { ByteMarker };`],
  ['enum binding escapes', `${LOCAL_ENUM} globalThis.leak = ByteMarker;`],
  ['enum passed to unknown code', `${LOCAL_ENUM} mutate(ByteMarker);`],
  ['enum property rewritten', `${LOCAL_ENUM} ByteMarker.Object = globalThis;`],
  ['enum parameter reassigned', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})', `ByteMarker2 = globalThis; ${BODY}`)}`],
  ['enum parameter escapes', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})', `${BODY} leak(ByteMarker2);`)}`],
  ['enum value has side effects', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})', BODY.replace('= 8', '= leak()'))}`],
  ['reverse member has side effects', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})', BODY.replace('= "Object";', '= leak();'))}`],
  ['argument is user derived', iife('readEnum()')],
  ['fallback aliases globalThis', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = globalThis)')}`],
  ['fallback aliases self', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = self)')}`],
  ['fallback object has spread', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = { ...globalThis })')}`],
  ['fallback object has getter', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = { get Object() { return globalThis; } })')}`],
  ['different fallback binding', `var ByteMarker, Other; ${iife('ByteMarker || (Other = {})')}`],
  ['extra IIFE argument', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {}), globalThis')}`],
  ['defaulted IIFE parameter', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})').replace('function(ByteMarker2)', 'function(ByteMarker2 = globalThis)')}`],
  ['named IIFE could escape recursively', `var ByteMarker; ${iife('ByteMarker || (ByteMarker = {})').replace('function(ByteMarker2)', 'function recur(ByteMarker2)')}`],
  ['with changes argument lookup', `var ByteMarker; with (globalThis) { ${iife('ByteMarker || (ByteMarker = {})')} }`],
  ['global write beside benign enum', `${LOCAL_ENUM} globalThis.Object = {};`],
  ['self write beside benign enum', `${LOCAL_ENUM} self["Object"] = {};`],
  ['global alias write beside benign enum', `${LOCAL_ENUM} var root = globalThis; root["Object"] = {};`],
  ['Object alias write beside benign enum', `${LOCAL_ENUM} var ctor = Object; ctor["defineProperty"] = (t) => t;`],
  ['direct intrinsic write beside benign enum', `${LOCAL_ENUM} Object.defineProperty = (t) => t;`],
];
describe('enum-shaped intrinsic/global writes stay unproven under nodejs_compat', () => {
  test.each(adverse)('%s is refused', (_name, extra) => {
    const source = forwarder(extra);
    expect(scanModule(source).dynamic?.[0]?.via).toBe('unproven');
    expect(problems(source).join('\n')).toMatch(/dynamic import/);
  });
});
