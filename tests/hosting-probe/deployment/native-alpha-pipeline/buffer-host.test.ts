import {describe,expect,it} from 'vitest';
import {scanModule} from '../../../../deploy/probes/target.ts';
import {uploadModuleProblems} from '../../../../deploy/native-alpha/pipeline.ts';
const entry="import {Buffer} from 'node:buffer'; export default {fetch(){return new Response(Buffer.from('abc').toString('base64'));}};";
describe('exact static Worker Buffer host capability',()=>{
 it('permits the real SDK static host import only with explicit nodejs_compat',()=>{
  expect(uploadModuleProblems(scanModule(entry),'worker.js',['nodejs_compat'])).toEqual([]);
 });
 it.each([undefined,[],['nodejs_als'],['nodejs_compat_v2'],['nodejs_compat','no_nodejs_compat']])('refuses absent/disabled target policy %j',flags=>{
  expect(uploadModuleProblems(scanModule(entry),'worker.js',flags)).not.toEqual([]);
 });
 it('does not permit dynamic Buffer, bare aliases, subpaths or other Node capabilities',()=>{
  for(const source of ["export const p=import('node:buffer');","import 'buffer';","import 'node:buffer/internal';","import 'node:fs/promises';","import 'node:net';"]){
   expect(uploadModuleProblems(scanModule(source),'worker.js',['nodejs_compat']),source).not.toEqual([]);
  }
 });
});
