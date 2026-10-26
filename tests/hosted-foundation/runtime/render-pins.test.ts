// Build-configuration lookup only: not browser, native runtime or asset-delivery evidence.
import {afterEach,expect,it,vi} from 'vitest';
import {prepareHostedStaticInput} from '../../../scripts/hosted-static-input.ts';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('leaves missing production inventory unavailable, without env or request fallback',async()=>{
 vi.resetModules();vi.stubGlobal('__CLEARCASE_PDF_ASSETS__',undefined);
 const {compiledPdfAssetPins}=await import('../../../src/lib/server/runtime/hosted/render-pins.ts');
 expect(compiledPdfAssetPins()).toBeNull();
});
it('retains immutable public configuration from the actual verified pinned static inventory',async()=>{
 const input=prepareHostedStaticInput(process.cwd());
 try{
  vi.resetModules();vi.stubGlobal('__CLEARCASE_PDF_ASSETS__',input.inventory);
  const {compiledPdfAssetPins}=await import('../../../src/lib/server/runtime/hosted/render-pins.ts');
  const pins=compiledPdfAssetPins();
  expect(pins?.files).toHaveLength(191);
  expect(pins?.pdfjsVersion).toBe('6.4.299');
  expect(pins).toBe(compiledPdfAssetPins());
  expect(Object.isFrozen(pins)).toBe(true);expect(Object.isFrozen(pins?.files)).toBe(true);
 }finally{input.dispose();}
});
