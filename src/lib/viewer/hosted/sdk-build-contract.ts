/** Pure shared byte identity: the build applies these pins; the renderer binds them into durable fact identity. */
export const NATIVE_SDK_BUILD_SCHEMA='clearcase.native-render-sdk-build/1';
export const NATIVE_SDK_INPUT_PINS=Object.freeze({
 version:'1.4.0', packageSha256:'8ab3e1d7431161bccb5ac1c7198eee3077aa14912a74290764b71583a9699166',
 esmInventorySha256:'65d81a63ea1ea2a381d29260aad55d9737ca513b345efc68b66a88c4df539005', modules:144,
});
export const NATIVE_SDK_BUFFER_SOURCE="export { Buffer } from 'node:buffer';\n";
export const NATIVE_SDK_DEBUG_SOURCE="export default function debug() { throw Error('native render SDK Node diagnostics refused'); }\n";
export const NATIVE_SDK_WORKER_OUTPUTS:Readonly<Record<string,string>>=Object.freeze({
 'puppeteer/cloudflare/PuppeteerWorkers.js':'01743bfb29b39e4cb164fd5af7e4b3a679af925ea16bbf70eb02952342c7065f',
 'puppeteer/environment.js':'2a5e664e943102a3e3cf15c51b521edde0da5f139e93ed1368be6693624daae1',
 'puppeteer/common/util.js':'bd3e757520c301ae67f66047c3b626178da11a4580efa15e807feef258a1b6a4',
 'puppeteer/cdp/ElementHandle.js':'6815afe625aa56f87058ed745772d943147443ccacaa4e0df07f1ba9c7664e51',
 'puppeteer/api/Page.js':'a7ce8d8fc342f9d2d7903c3f9d188e1808b22f8da9b0a0d2fd09bfca74aa8ce4',
 'puppeteer/cdp/HTTPResponse.js':'cce51077cfb109ee1cca5b147f789a6d43c848f7dfca28f72406eca9f75f9343',
 'puppeteer/common/BrowserConnector.js':'db97c7501ad3b626b1b6e0f3fe736b8a350999d2da0d6c17415a5489a5fffb4b',
 'puppeteer/common/BrowserWebSocketTransport.js':'aa0064de9edc9ed95d35e64cce447b0946ac672994408c3aaf0e23b871f5563a',
 'puppeteer/util/disposable.js':'3982da81e9f0df031641139679f90f070cd9bc3364c9f43b9301f3ac275ae133',
 'puppeteer/cdp/Binding.js':'3b54bb627459344244ab191d31a5fa912953e97fe235b1b7ef217cbe065bfe90',
 'puppeteer/cdp/utils.js':'a146a7fa3ef9aa95cc8c0a14f68ceea8077ea2bbac4faa06211a2b70171f106b',
 'puppeteer/cdp/Frame.js':'062705e7d79e59ece03b535d3ba937c620d40bfd39a2fae522d310abd3e3395d',
 'puppeteer/cdp/ExecutionContext.js':'86957c2c772957b40334bff53858d13d7866eb4d46c8099e9918bc57f991864c',
});
/** Host intrinsics the transformed SDK reads and never defines. The factory refuses a host without them. */
export const NATIVE_SDK_HOST_SYMBOLS=Object.freeze(['Symbol.dispose','Symbol.asyncDispose'] as const);
export const NATIVE_SDK_POLICY_IDENTITY=Object.freeze({
 schema:NATIVE_SDK_BUILD_SCHEMA, inputs:NATIVE_SDK_INPUT_PINS, transforms:NATIVE_SDK_WORKER_OUTPUTS,
 hostBuffer:NATIVE_SDK_BUFFER_SOURCE, deniedNodeDiagnostics:NATIVE_SDK_DEBUG_SOURCE, hostSymbols:NATIVE_SDK_HOST_SYMBOLS,
});
