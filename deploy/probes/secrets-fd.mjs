// Node preload for `secrets.ts --to fd` (GRS-107). It takes the values off fd 3, closes fd 3 and deletes
// CLEARCASE_SECRETS_FD before the child's own code runs, and keeps the values in this process for the child's one call
// to takeSecrets(). No process the child starts afterwards can inherit the pipe or the variable.
import { keepSecrets } from './secrets-child.mjs';

keepSecrets();
