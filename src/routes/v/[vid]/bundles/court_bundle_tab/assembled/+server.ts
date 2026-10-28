import { error, json } from '@sveltejs/kit';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from '$lib/local-case/app.server';
import { digest } from '$lib/server/runtime/data';
import { pdfForm, bundleObjectKey } from '$lib/views/bundles/assembled';
import { customOf } from '$lib/bundles/builder';
import { readCustom, saveCustom } from '$lib/views/bundles/store.server';
import type { RequestHandler } from './$types';
export const POST:RequestHandler=async({params,request})=>{
 const a=app(),c=a.store.getVersion(params.vid)?.case_id;if(!c)error(404,'Not found.');
 const data=await pdfForm(request);if(!data)return json({message:'Upload a PDF no larger than 64 MiB.'},{status:400});
 const id=String(data.form.get('id')??'');if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))error(400,'Invalid bundle.');
 let value:unknown;try{value=JSON.parse(String(data.form.get('bundle')??''));}catch{error(400,'Invalid bundle.');}
 const entry=customOf(value&&typeof value==='object'?{...value,no:'C'}:null);if(!entry)error(400,'Invalid bundle.');
 const sha256=await digest(data.bytes),file=path.join(a.config.dataDir,bundleObjectKey(c,id,sha256));
 await mkdir(path.dirname(file),{recursive:true});
 try{await writeFile(file,data.bytes,{flag:'wx',mode:0o600});}catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='EEXIST')throw e;}
 await writeFile(path.join(path.dirname(file),'assembled.json'),JSON.stringify({sha256,bytes:data.bytes.length}),{mode:0o600});
 const no=await saveCustom(c,id,entry,[]);return json({saved:true,id,no});
};
export const GET:RequestHandler=async({params,url})=>{
 const a=app(),c=a.store.getVersion(params.vid)?.case_id;if(!c)error(404,'Not found.');
 const saved=(await readCustom(c)).find(r=>r.id===url.searchParams.get('id'));if(!saved?.assembledSha256)error(404,'Not found.');
 const bytes=await readFile(path.join(a.config.dataDir,bundleObjectKey(c,saved.id,saved.assembledSha256)));
 return new Response(bytes,{headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="Bundle.pdf"','cache-control':'private, no-store'}});
};
