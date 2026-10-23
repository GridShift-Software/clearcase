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

    def test_destructured_container_alternatives_keep_fixed_keys(self):
        local = ("const pick = true; const { k = 'constructor' } = "
                 "(pick ? { k: 'constructor' } : []) as any;")
        self.reject_key('conditional object-or-array destructuring', local, 'k')

        exported = ("import { k } from './keys';")
        self.reject_key('exported conditional destructuring', exported, 'k', {
            'src/keys.ts': "const pick = true; export const { k = 'constructor' } = "
                           "(pick ? { k: 'constructor' } : []) as any;"})

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

    def test_element_reads_and_mutable_literal_members_refuse(self):
        for label, setup, key in (
                ('object element read', "const K = { k: 'constructor' };", 'K.k'),
                ('array element read', "const K = ['constructor'];", 'K[0]'),
                ('safe initial member is still mutable', "const K = { k: 'safe' };", 'K.k'),
                ('mutated object', "const K = { k: 'safe' }; K.k = 'constructor';", 'K.k'),
                ('mutated alias', "const K = ['safe']; const A = K; A[0] = 'constructor';", 'K[0]'),
                ('escaped object', "const K = { k: 'safe' }; change(K);", 'K.k'),
                ('getter member', "const K = { get k() { return 'constructor'; } };", 'K.k'),
                ('spread member', "const K = { ...source, k: 'constructor' };", 'K.k'),
                ('cyclic member', 'const K = { k: K.k };', 'K.k')):
            self.route(label, {'src/api.ts': setup + f'\n({{}} as any)[{key}].is = () => true;\n'
                              + self.weakened}, why='reaches the test framework')
        self.reject_key('logical literal receiver', '', "(undefined ?? { k: 'constructor' }).k")

    def test_scalar_logical_keys_and_runtime_bounds_pass(self):
        for key in ("undefined ?? 'safe'", "false && 'constructor'", "0 ?? 'constructor'",
                    "'' && 'constructor'", "0n && 'constructor'", "'safe' || 'constructor'",
                    "(false || 0) ?? 'constructor'", "(1 + 1 === 2) ? 'safe' : 'other'"):
            self.route(key, {'src/api.ts': f'const {{ [{key}]: value }} = {{}};\n' + self.weakened})
        for label, code in (
                ('join', "const k = ['constr', 'uctor'].join(''); const { [k]: C } = {} as any; C.is = () => true;"),
                ('fromCharCode', "const k = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ({} as any)[k].is = () => true;"),
                ('String.raw', "const k = String.raw`constructor`; ({} as any)[k].is = () => true;"),
                ('Object.freeze', "const K = Object.freeze({ k: 'constructor' }); ({} as any)[K.k].is = () => true;"),
                ('call', "const k = compute(); ({} as any)[k].is = () => true;"),
                ('parameter shadows undefined', "function f(undefined: string) { ({} as any)[undefined ?? 'safe'].is = () => true; }"),
                ('parameter shadows literal owner', "const K = { k: 'unused' }; function f(K: any) { ({} as any)[K.k].is = () => true; }"),
                ('loop variable', "for (const K of [{ k: 'constructor' }]) { ({} as any)[K.k].is = () => true; }"),
                ('runtime selector', "const K = { k: 'constructor' }; const k = compute(); ({} as any)[K[k]].is = () => true;"),
                ('mutable array length', "const out = []; out.push(compute()); const last = out[out.length - 1];"),
                ('let variable', "let k = 'constructor'; ({} as any)[k].is = () => true;")):
            self.route(label, {'src/api.ts': code + '\n' + self.weakened})

    def test_symbol_keys_have_separate_identity_and_keep_framework_protection(self):
        for key in ("Symbol.for('Object')", "Symbol['for']('constructor')", "Symbol.for('app.cache')"):
            self.route(key, {'src/api.ts': f'globalThis[{key}].is = () => true;\n' + self.weakened})
        self.route('symbol alias', {'src/api.ts': "const k = Symbol.for('Object'); globalThis[k].is = () => true;\n"
                                   + self.weakened})
        for key in ("'Object'", "Symbol.for('$$jest-matchers-object')", "Symbol['for']('vitest.matchers')",
                    "`${Symbol.for('constructor')}`", "'cons' + Symbol.for('tructor')"):
            self.route(key, {'src/api.ts': f'globalThis[{key}].is = () => true;\n' + self.weakened},
                       why='reaches the test framework')

    def test_namespace_aliases_and_scalar_imports_keep_bindings(self):
        self.reject_key('namespace scalar alias', "import * as N from './keys'; const A = N;", 'A.k',
                        {'src/keys.ts': "export const k = 'constructor';"})
        self.reject_key('imported undefined', "import { k } from './keys';", "k ?? 'constructor'",
                        {'src/keys.ts': 'export const k = undefined;'})
        self.reject_key('scalar aliases with falsy values', 'const a = false; const b = a; const k = b;',
                        "k || 'constructor'")
        self.reject_key('namespace destructuring', "import * as N from './keys'; const { K } = N;", 'K.k',
                        {'src/keys.ts': "export const K = { k: 'constructor' };"})
        self.reject_key('literal source alias destructuring', "const A = { k: 'constructor' }; const { k } = A;", 'k')
        self.reject_key('namespace binding default', "import * as N from './keys'; const { k = 'constructor' } = N;", 'k',
                        {'src/keys.ts': 'export const k = undefined;'})
        self.reject_key('nested namespace binding default', "import * as N from './keys'; const { a: { k } = { k: 'constructor' } } = N;", 'k',
                        {'src/keys.ts': 'export const a = undefined;'})
        self.reject_key('short-circuit before runtime call', '', "'constructor' || compute()")
        self.route('namespace destructured runtime result', {'src/api.ts': "import * as N from './keys'; const { k } = N; "
                   "({} as any)[k].is = () => true;\n" + self.weakened},
                   base={'src/keys.ts': 'export const k = compute();'})


if __name__ == '__main__':
    unittest.main()
