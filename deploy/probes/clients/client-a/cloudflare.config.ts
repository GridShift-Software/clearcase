// The reviewed cf config for synthetic client-a (GRS-107). Data only: deploy/probes/target.ts reads the JSON literal
// below and never evaluates this file. Placeholder account and D1 IDs that no Cloudflare account holds.
export default {
  "accountId": "00000000000000000000000000000107",
  "worker": {
    "name": "clearcase-client-a",
    "compatibilityDate": "2026-10-12",
    "compatibilityFlags": ["nodejs_als"],
    "entrypoint": "./artifact/cloudflare/_worker.js",
    "env": {
      "DB": { "type": "d1", "name": "clearcase-client-a-db", "id": "00000000-0000-4000-8000-00000000aaaa" },
      "BUCKET": { "type": "r2", "name": "clearcase-client-a-files" },
      "CLERK_SECRET_KEY": { "type": "secret" },
      "CLEARCASE_CLIENT_ID": { "type": "text", "value": "client-a" }
    }
  }
};
