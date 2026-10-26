/**
 * Parent build hook ONLY, not a renderer or an SDK replacement. No filesystem, provider calls or global patches.
 * Apply to these two exact official @cloudflare/puppeteer 1.4.0 ESM modules in the renderer's artifact graph.
 * Reject unknown bytes. The parent owns hook installation, closure review and inspection of the final artifact.
 * Keep diagnostics enabled/capturable, but never pass protocol bodies, provider errors or session IDs to sinks.
 */
const POLICY_ID = 'clearcase.native-render-sdk-policy/1';
const modules = {
 'common/Debug.js': {
  sha256: '53175b20aafb7e94b5793c48b0d05d21f7c990b496ec2775442539fd573c17b8',
  outputSha256: '0faf6d5add4b7e507d647cd7a5bd91a44731175f1097a3aa30472f9f1da569ff',
  edits: [
   ["capturedLogs.push(prefix + logArgs);", "capturedLogs.push(prefix + ': [native render SDK event]');"],
   ["(await importDebug())(prefix)(logArgs);", "(await importDebug())(prefix)('[native render SDK event]');"],
   ["console.log(`${prefix}:`, ...logArgs);", "console.log(`${prefix}:`, '[native render SDK event]');"],
  ],
 },
 'cloudflare/utils.js': {
  sha256: '82497d81581f5bd698e10091e8de190c754fe9fa0f5bda3292b783a8a681e81e',
  outputSha256: '2d1c09d0a561f971fc2ca8aa459f0372beb68e3e39f42f823ac7e160d9c89ddb',
  // Defense in depth only. The checker STILL requires its own root-CDP acknowledgement and peer termination.
  edits: [["connection.send('Browser.close').catch(console.log)", "connection.send('Browser.close').catch(() => { throw Error('native render SDK close refused'); })"]],
 },
} as const;
// The renderer's owned HTML (and therefore its fingerprint) binds both actual policy output pins, not just a name.
export const NATIVE_RENDER_SDK_POLICY = POLICY_ID + ';' + Object.values(modules).map(m => 'sha256:' + m.outputSha256).join(';');
const digest = async (source: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))]
 .map(v => v.toString(16).padStart(2, '0')).join('');

export async function applyNativeRenderSdkPolicy(path: string, source: string): Promise<{
 code: string; policyId: string; inputSha256: string; outputSha256: string;
}> {
 if (path !== 'common/Debug.js' && path !== 'cloudflare/utils.js') throw Error('native render SDK policy module refused');
 const module = modules[path], inputSha256 = await digest(source);
 if (inputSha256 !== module.sha256) throw Error('native render SDK policy source refused');
 let code = source;
 for (const [before, after] of module.edits) {
  if (code.split(before).length !== 2) throw Error('native render SDK policy shape refused');
  code = code.replace(before, after);
 }
 code = code.replace(/\n\/\/# sourceMappingURL=[^\n]*/g, '');
 const outputSha256 = await digest(code);
 if (outputSha256 !== module.outputSha256) throw Error('native render SDK policy output refused');
 return { code, policyId: NATIVE_RENDER_SDK_POLICY, inputSha256, outputSha256 };
}
