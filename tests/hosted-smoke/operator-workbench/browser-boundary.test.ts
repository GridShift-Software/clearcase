import {expect,it} from 'vitest';
import {build} from 'esbuild';
import path from 'node:path';

it('keeps the actual operator digest graph browser-safe without a server-namespace waiver',async()=>{
 const root=process.cwd();
 const result=await build({entryPoints:[path.join(root,'src/lib/results-review/native/digest.ts')],bundle:true,platform:'browser',write:false,metafile:true,logLevel:'silent',plugins:[{
  name:'refuse-server-capabilities',setup(b){
   b.onResolve({filter:/.*/},a=>{
    if(a.path.startsWith('node:'))throw Error('browser Node capability refused');
    if(a.importer&&a.path.startsWith('.')&&path.resolve(path.dirname(a.importer),a.path).startsWith(path.join(root,'src/lib/server')+path.sep))throw Error('browser server namespace refused');
    return undefined;
   });
  },
 }]});
 expect(Object.keys(result.metafile!.inputs)).toContain('src/lib/shared/data.ts');
 expect(Object.keys(result.metafile!.inputs).some(p=>p.startsWith('src/lib/server/'))).toBe(false);
 expect(result.outputFiles).toHaveLength(1);
});
it('retains the single exact portable/server SHA, freeze and clone implementation',async()=>{
 const shared=await import('../../../src/lib/shared/data.ts'),server=await import('../../../src/lib/server/runtime/data.ts');
 expect(server.digest).toBe(shared.digest);expect(server.freeze).toBe(shared.freeze);expect(server.copy).toBe(shared.copy);
 expect(await shared.digest(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 const value={nested:{a:[1]}};const clone=shared.copy(value);shared.freeze(clone);
 expect(clone).toEqual(value);expect(clone).not.toBe(value);expect(Object.isFrozen(clone.nested.a)).toBe(true);expect(Object.isFrozen(value)).toBe(false);
});
