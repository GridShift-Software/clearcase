// TEST DOUBLE ENTRY (hosted-gate profile only): see ./services.ts.
import { env } from 'cloudflare:workers';
import { createHandle, handleError } from '../handle.ts';
import { gateServices } from './services.ts';

export const handle = createHandle((request) => gateServices(request, env));
export { handleError };
