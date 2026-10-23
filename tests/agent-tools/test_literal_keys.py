"""GRS-190: synthetic controls through the actual test-weakening guard CLI."""
import unittest

import test_controls as controls


class LiteralKeys(controls.GuardCase):
    api = controls.GuardAllowlist.api
    named_api = controls.GuardAllowlist.named_api
    weakened = controls.GuardAllowlist.weakened
    route = controls.GuardRoutes.route

    def reject_key(self, label, setup, key, base=None):
        self.route(label, {'src/api.ts': setup + f'\nconst {{ [{key}]: C }} = {{}} as any; C.is = () => true;\n'
                          + self.weakened}, base=base, why='reaches the test framework')

    def test_literal_member_routes_refuse(self):
        for label, setup, key in (
                ('const object dot', "const K = { k: 'constructor' } as const;", 'K.k'),
                ('const object computed', "const K = { k: 'constructor' };", "K['k']"),
                ('const object alias', "const K = { k: 'constructor' }; const A = K;", 'A.k'),
                ('nested object and array', "const K = { a: [{ k: 'constructor' }] } as const;", "K.a[0].k"),
                ('const array', "const K = ['constructor'] as const;", 'K[0]'),
                ('plain enum', "enum K { k = 'constructor' }", 'K.k'),
                ('const enum', "const enum K { k = 'constructor' }", "K['k']"),
                ('object destructuring', "const { k } = { k: 'constructor' };", 'k'),
                ('renamed destructuring', "const { a: k } = { a: 'constructor' };", 'k'),
                ('array destructuring', "const [k] = ['constructor'];", 'k'),
                ('nested destructuring', "const { a: [k] } = { a: ['constructor'] };", 'k'),
                ('destructuring default', "const { k = 'constructor' } = {};", 'k'),
                ('destructured member', "const { a } = { a: { k: 'constructor' } };", 'a.k'),
                ('destructured rest', "const [a, ...K] = ['unused', 'constructor'];", 'K[0]')):
            self.reject_key(label, setup, key)

    def test_imported_literal_members_refuse(self):
        for label, declaration, imported, key in (
                ('named object', "export const K = { k: 'constructor' };", "import { K } from './keys';", 'K.k'),
                ('default array', "export default ['constructor'] as const;", "import K from './keys';", 'K[0]'),
                ('namespace object', "export const K = { k: 'constructor' };", "import * as N from './keys';", 'N.K.k'),
                ('plain enum', "export enum K { k = 'constructor' }", "import { K } from './keys';", 'K.k'),
                ('const enum', "export const enum K { k = 'constructor' }", "import { K } from './keys';", 'K.k'),
                ('exported binding', "export const { k } = { k: 'constructor' };", "import { k } from './keys';", 'k'),
                ('namespace alias', "export const K = ['constructor'];", "import * as N from './keys'; const A = N;", 'A.K[0]')):
            self.reject_key(label, imported, key, {'src/keys.ts': declaration})
        self.reject_key('re-exported member', "import { A } from './middle';", 'A.k', {
            'src/keys.ts': "export const K = { k: 'constructor' };",
            'src/middle.ts': "export { K as A } from './keys';"})

    def test_literal_logical_operands_refuse(self):
        for key in ("undefined ?? 'constructor'", "void 0 ?? 'constructor'", "null ?? 'constructor'",
                    "false || 'constructor'", "0 || 'constructor'", "0n || 'constructor'",
                    "'' || 'constructor'", "true && 'constructor'", "1 && 'constructor'",
                    "'constructor' || 0", "'constructor' ?? 'safe'", "(false || undefined) ?? 'constructor'"):
            self.reject_key(key, '', key)


if __name__ == '__main__':
    unittest.main()
