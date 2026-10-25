import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
 NATIVE_SDK_BUILD_SCHEMA, NATIVE_SDK_INPUT_PINS, NATIVE_SDK_WORKER_OUTPUTS,
 NATIVE_SDK_BUFFER_SOURCE, NATIVE_SDK_DEBUG_SOURCE, NATIVE_SDK_POLICY_IDENTITY,
} from '../../../src/lib/viewer/hosted/sdk-build-contract.ts';
import { fixture, bundle } from '../native-sdk-build/harness.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fixtures: ReturnType<typeof fixture>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)) f.dispose();});

describe('native renderer build identity (unit/build-only)',()=>{
 it('captures independently measured installed SDK inventory and exact virtual sources',async()=>{
  const pkg=JSON.parse(readFileSync('node_modules/@cloudflare/puppeteer/package.json','utf8'));
  const root='node_modules/@cloudflare/puppeteer/lib/esm';
  const files:string[]=[];
  const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.js')&&!entry.name.endsWith('.test.js'))files.push(file);}};
  walk(root);files.sort((a,b)=>path.relative(root,a)<path.relative(root,b)?-1:1);
  const inventory=JSON.stringify(files.map(file=>({module:path.relative(root,file),sha256:hash(readFileSync(file,'utf8'))})));
  expect(pkg.version).toBe('1.4.0');
  expect(files).toHaveLength(144);
  expect(hash(inventory)).toBe('65d81a63ea1ea2a381d29260aad55d9737ca513b345efc68b66a88c4df539005');
  expect(NATIVE_SDK_INPUT_PINS).toMatchObject({version:pkg.version,modules:files.length,esmInventorySha256:hash(inventory)});
  expect(NATIVE_SDK_BUFFER_SOURCE).toBe("export { Buffer } from 'node:buffer';\n");
  expect(NATIVE_SDK_DEBUG_SOURCE).toBe("export default function debug() { throw Error('native render SDK Node diagnostics refused'); }\n");
  expect(NATIVE_SDK_POLICY_IDENTITY).toEqual({schema:NATIVE_SDK_BUILD_SCHEMA,inputs:NATIVE_SDK_INPUT_PINS,transforms:NATIVE_SDK_WORKER_OUTPUTS,hostBuffer:NATIVE_SDK_BUFFER_SOURCE,deniedNodeDiagnostics:NATIVE_SDK_DEBUG_SOURCE});
  expect(Object.isFrozen(NATIVE_SDK_INPUT_PINS)).toBe(true);
  expect(Object.isFrozen(NATIVE_SDK_WORKER_OUTPUTS)).toBe(true);
  expect(Object.isFrozen(NATIVE_SDK_POLICY_IDENTITY)).toBe(true);
  expect(Object.keys(NATIVE_SDK_WORKER_OUTPUTS)).toHaveLength(8);
 });
 it('agrees with actual scoped build receipts without claiming native SDK/render evidence',async()=>{
  const f=fixture();fixtures.push(f);await bundle(f.root);
  const receipt=JSON.parse(readFileSync(path.join(f.root,'.local/native-render-sdk-build/ssr.json'),'utf8'));
  expect(receipt.evidence).toBe('SCOPED-BUNDLE-NOT-NATIVE');
  expect(receipt.schema).toBe(NATIVE_SDK_BUILD_SCHEMA);
  expect(receipt.pins).toEqual(NATIVE_SDK_INPUT_PINS);
  for(const [module,outputSha256] of Object.entries(NATIVE_SDK_WORKER_OUTPUTS))
   expect(receipt.modules.find((item:{module:string})=>item.module===module)).toMatchObject({outputSha256});
 });
});
