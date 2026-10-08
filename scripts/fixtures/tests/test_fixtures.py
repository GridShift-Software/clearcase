"""Behavior tests for the v5 fixture inventory. Synthetic data only.

Run: python3 -m unittest discover -s scripts/fixtures/tests -v
"""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.dirname(HERE)
sys.path.insert(0, FIXTURES)
sys.path.insert(0, HERE)

import synth  # noqa: E402
from v5fixture import archive, build, examples, html, jslit, redact  # noqa: E402
import count_actions  # noqa: E402
import leak_check  # noqa: E402

CLI = os.path.join(FIXTURES, "inventory.py")


class Temp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cc01-test-")

    def tearDown(self):
        for dirpath, dirnames, filenames in os.walk(self.tmp):
            for n in dirnames + filenames:
                p = os.path.join(dirpath, n)
                if not os.path.islink(p):
                    os.chmod(p, 0o755)
        shutil.rmtree(self.tmp)

    def path(self, *parts):
        return os.path.join(self.tmp, *parts)


class JsLiteralTest(unittest.TestCase):
    def test_parses_nav_style_literal(self):
        src = "const NAV=[\n ['Matter',[['overview','Over\\'view',\"i\"],]], // c\n /* x */ ['B',[]],\n];"
        value, _ = jslit.parse_at(src, src.index("["))
        self.assertEqual(value, [["Matter", [["overview", "Over'view", "i"]]], ["B", []]])

    def test_objects_numbers_and_constants(self):
        self.assertEqual(jslit.parse("{a:1, 'b':-2.5e1, 3:[true,false,null],}"),
                         {"a": 1, "b": -25.0, "3": [True, False, None]})

    def test_rejects_code(self):
        for bad in ("[a]", "[f()]", "[`t`]", "[...x]", "{a:1+2}", "new Set([1])", "{a:1,a:2}", "['\\101']"):
            with self.subTest(bad=bad), self.assertRaises(jslit.JsLiteralError):
                jslit.parse(bad)

    def test_rejects_member_access_after_literal(self):
        src = "const X=[1,2].map(f);"
        with self.assertRaises(jslit.JsLiteralError):
            jslit.parse_at(src, src.index("["))


class HtmlTest(unittest.TestCase):
    def test_extracts_datasets_and_literals(self):
        ws = html.parse(synth.workspace_html(synth.rows(synth.DEFAULT_ROWS)))
        self.assertEqual(ws.meta["docCount"], 3)
        self.assertEqual(len(ws.data["chronology"]), 3)
        self.assertEqual([n["id"] for n in ws.nav()], ["overview", "chronology", "deadlines_tab"])
        self.assertEqual(ws.literals["STORE_KEYS"], ["ess_dcs_deadlines_v1", "ess_dcs_legacy_v1"])
        self.assertNotIn("Synthetic subject", ws.code)

    def test_rejects_non_json_constants_and_duplicate_keys(self):
        good = synth.workspace_html(synth.rows(synth.DEFAULT_ROWS)).decode()
        for needle, repl in (('"docCount": 3', '"docCount": NaN'), ('"docCount": 3', '"docCount": 3, "docCount": 4')):
            with self.subTest(repl=repl), self.assertRaises(html.HtmlDataError):
                html.parse(good.replace(needle, repl, 1).encode())

    def test_requires_data_and_nav(self):
        good = synth.workspace_html(synth.rows(synth.DEFAULT_ROWS)).decode()
        with self.assertRaises(html.HtmlDataError):
            html.parse(good.replace("const DATA = ", "let DATA_ = ").encode())
        with self.assertRaises(html.HtmlDataError):
            html.parse(good.replace("const NAV=", "const NAV_OLD=").encode())

    def test_code_is_identical_across_data_only_variants(self):
        a = html.parse(synth.workspace_html(synth.rows(synth.DEFAULT_ROWS)))
        b = html.parse(synth.workspace_html(synth.rows(synth.DEFAULT_ROWS[:2]), built="2030-01-01 00:00"))
        self.assertNotEqual(a.sha256, b.sha256)
        self.assertEqual(a.code_sha256, b.code_sha256)


class ArchiveTest(Temp):
    def test_unflagged_utf8_names_are_redecoded(self):
        """Lane 4: names with spaces and non-ASCII characters, stored without the zip UTF-8 flag."""
        z = synth.make_zip(self.path("a.zip"), unflagged=("CORRESPONDENCE/Ünïcode – mail.eml",))
        with zipfile.ZipFile(z) as zf:
            naive = {i.filename for i in zf.infolist()}
        self.assertNotIn("CORRESPONDENCE/Ünïcode – mail.eml", naive)
        src = archive.ZipSource(z)
        entry = next(e for e in src.entries if e.path.startswith("CORRESPONDENCE/Ü"))
        self.assertEqual(entry.path, "CORRESPONDENCE/Ünïcode – mail.eml")
        self.assertEqual(entry.name_encoding, "utf8-unflagged")

    def test_unsafe_entries_are_rejected_and_never_extracted(self):
        """Lane 5: '..', absolute, drive-letter, backslash and symlink entries."""
        raw = []
        for name in ("../escape.txt", "/abs.txt", "C:/drive.txt", "dir\\back.txt", "a/../../b.txt"):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            raw.append((info, b"x"))
        raw.append(synth.symlink_info("link.pdf"))
        z = synth.make_zip(self.path("bad.zip"), raw_entries=raw)
        src = archive.ZipSource(z)
        reasons = {u["path"]: u["reason"] for u in src.unsafe}
        self.assertEqual(len(reasons), 6, reasons)
        self.assertIn("symlink", reasons["link.pdf"])
        out = self.path("tree")
        archive.extract(src, out)
        self.assertFalse(os.path.exists(self.path("escape.txt")))
        self.assertFalse(os.path.lexists(os.path.join(out, "link.pdf")))
        self.assertEqual(sorted(e.path for e in archive.TreeSource(out).entries), sorted(e.path for e in src.entries))

    def test_check_relpath(self):
        for bad in ("", "../x", "a/./b", "a//b", "/x", "\\x", "C:x", "a\x00b"):
            with self.subTest(bad=bad), self.assertRaises(archive.UnsafePath):
                archive.check_relpath(bad)
        self.assertEqual(archive.check_relpath("A b/Ü – c.pdf"), "A b/Ü – c.pdf")

    def test_extract_checks_crc_and_keeps_identical_files(self):
        z = synth.make_zip(self.path("a.zip"))
        out = self.path("tree")
        first = archive.extract(archive.ZipSource(z), out)
        again = archive.extract(archive.ZipSource(z), out)
        self.assertEqual((first["written"], again["written"], again["kept"]), (first["files"], 0, first["files"]))
        target = os.path.join(out, "ORIGINALS/(1) Letter one.pdf")
        self.assertFalse(os.stat(target).st_mode & 0o222)
        os.chmod(target, 0o644)
        with open(target, "ab") as fh:
            fh.write(b"tampered")
        with self.assertRaises(RuntimeError):
            archive.extract(archive.ZipSource(z), out)

    def test_corrupt_member_fails_extraction(self):
        z = synth.make_zip(self.path("a.zip"))
        data = bytearray(pathlib.Path(z).read_bytes())
        i = data.index(b"invoice two")
        data[i] ^= 0xFF
        pathlib.Path(z).write_bytes(bytes(data))
        with self.assertRaises((RuntimeError, zipfile.BadZipFile)):
            archive.extract(archive.ZipSource(z), self.path("tree"))
        self.assertFalse(os.path.exists(self.path("tree", "ORIGINALS/(2) Invoice two.pdf")))

    def test_extract_never_creates_a_directory_through_a_symlinked_directory(self):
        """Lane 5 (r2 regression): an existing symlink in the tree must not let extraction create anything
        outside it. Round 1 created outside/newdir before its containment check refused the file."""
        outside = self.path("outside")
        os.makedirs(outside)
        tree = self.path("tree")
        os.makedirs(tree)
        os.symlink(outside, os.path.join(tree, "ZZZ"))
        z = synth.make_zip(self.path("a.zip"), files={"ZZZ/newdir/f.pdf": b"%PDF-1.4 x\n"})
        with self.assertRaisesRegex(RuntimeError, "refusing to write outside"):
            archive.extract(archive.ZipSource(z), tree)
        self.assertEqual(os.listdir(outside), [])

    def test_tree_symlinks_are_unsafe_and_not_followed(self):
        """Lane 5: a symlink in an extracted tree is reported and never read."""
        root = self.path("tree")
        synth.write_tree(root, {"a/real.pdf": b"x"})
        os.symlink("/etc/passwd", os.path.join(root, "a/link.pdf"))
        os.symlink(self.tmp, os.path.join(root, "dirlink"))
        src = archive.TreeSource(root)
        self.assertEqual([e.path for e in src.entries], ["a/real.pdf"])
        self.assertEqual({u["path"] for u in src.unsafe}, {"a/link.pdf", "dirlink"})
        with self.assertRaises(archive.UnsafePath):
            src.read("../outside")


class BuildTest(Temp):
    def build_zip(self, **kw):
        return build.build(archive.ZipSource(synth.make_zip(self.path("a.zip"), **kw)))

    def test_zip_and_tree_give_identical_output(self):
        """Lane 1 (synthetic): rebuilds and both sources give byte-identical payloads."""
        z = synth.make_zip(self.path("a.zip"), unflagged=("CORRESPONDENCE/Ünïcode – mail.eml",))
        archive.extract(archive.ZipSource(z), self.path("tree"))
        dump = lambda v: json.dumps(v, ensure_ascii=False, indent=1)  # noqa: E731
        a = build.build(archive.ZipSource(z))
        b = build.build(archive.ZipSource(z))
        c = build.build(archive.TreeSource(self.path("tree")))
        self.assertEqual(dump(a), dump(b))
        self.assertEqual(dump(a), dump(c))

    def test_all_links_resolve_including_non_ascii(self):
        """Lane 4: percent-encoded names with spaces and non-ASCII characters resolve."""
        inv, summary = self.build_zip(unflagged=("CORRESPONDENCE/Ünïcode – mail.eml",))
        self.assertEqual(summary["missing"]["total"], 0)
        row = next(r for r in inv["refs"] if r["ref"] == "EM-0001")
        self.assertEqual((row["path"], row["status"]), ("CORRESPONDENCE/Ünïcode – mail.eml", "ok"))
        self.assertEqual(summary["files"]["nonAsciiNames"], 1)

    def test_missing_original_is_reported(self):
        """Lane 2: a referenced original that is absent from the archive."""
        files = dict(synth.DEFAULT_FILES)
        del files["ORIGINALS/(2) Invoice two.pdf"]
        inv, summary = self.build_zip(files=files)
        self.assertEqual(summary["missing"]["byStatus"], {"missing": 1})
        self.assertEqual([(m["field"], m["ref"], m["path"]) for m in inv["missing"]],
                         [("DATA.chronology[].url", "OD-002", "ORIGINALS/(2) Invoice two.pdf")])
        row = next(r for r in inv["refs"] if r["ref"] == "OD-002")
        self.assertEqual(row["status"], "missing")

    def test_duplicate_refs_and_duplicate_content(self):
        """Lane 3: duplicate legacy refs, two refs on one file and identical file content."""
        refs = synth.DEFAULT_ROWS + [("OD-001", "ORIGINALS/(2) Invoice two.pdf")]
        html_entries = {"Workspace.html": synth.workspace_html(synth.rows(refs))}
        inv, summary = self.build_zip(html_entries=html_entries)
        self.assertEqual(summary["duplicates"]["chronologyRefs"], ["OD-001"])
        self.assertEqual(inv["duplicates"]["chronologyRefs"], [{"ref": "OD-001", "rows": ["1", "4"]}])
        self.assertEqual(inv["duplicates"]["targetsSharedByRefs"],
                         [{"path": "ORIGINALS/(2) Invoice two.pdf", "refs": ["OD-002", "OD-001"]}])
        self.assertEqual(inv["duplicates"]["sameSizeAndCrc32"],
                         [["CORRESPONDENCE/copy of letter one.pdf", "ORIGINALS/(1) Letter one.pdf"]])

    def test_escaping_and_unsafe_links_are_not_resolved(self):
        """Lane 5: links leaving the case folder are reported, never read."""
        chron = synth.rows(synth.DEFAULT_ROWS)
        extra = {"contracts": {"items": [{"ref": "OD-001", "url": u} for u in (
            "../../etc/passwd", "/etc/passwd", "./a/%2E%2E/%2E%2E/x", "file:///etc/passwd", "./ok\\..\\x")]}}
        html_entries = {"Workspace.html": synth.workspace_html(chron, extra_data=extra)}
        inv, summary = self.build_zip(html_entries=html_entries)
        self.assertEqual(summary["missing"]["byStatus"], {"escapes": 3, "external-scheme": 1, "unsafe": 1})
        self.assertTrue(all(m["path"] is None for m in inv["missing"]))

    def test_links_are_normalized_like_a_browser_before_the_escape_check(self):
        """Lane 5 (r2 regression): the WHATWG URL parser strips leading and trailing C0 controls and spaces and
        drops tab, LF and CR, so ' /etc/x.pdf' opens /etc/x.pdf. Round 1 resolved it to a decoy zip entry
        named ' /etc/x.pdf' and reported it as ok."""
        files = dict(synth.DEFAULT_FILES)
        files[" /etc/decoy.pdf"] = b"%PDF-1.4 decoy\n"
        chron = synth.rows(synth.DEFAULT_ROWS)
        chron[1]["url"] = " /etc/decoy.pdf"
        inv, summary = self.build_zip(files=files, html_entries={"Workspace.html": synth.workspace_html(chron)})
        row = next(r for r in inv["refs"] if r["ref"] == "OD-002")
        self.assertEqual((row["status"], row["path"]), ("escapes", None))
        self.assertIn("OD-002", [m["ref"] for m in inv["missing"]])
        index = build.FileIndex(archive.ZipSource(self.path("a.zip")).entries, [])
        cases = {" /etc/decoy.pdf": "escapes", "\t/etc/x.pdf": "escapes", "\x01\x1f /etc/x": "escapes",
                 "/\n/host/x.pdf": "escapes", " \\\\host\\x": "escapes", " ../x.pdf": "escapes",
                 ".\t.\n/x.pdf": "escapes", " javascript:alert(1)": "external-scheme",
                 " ./ORIGINALS/(1)%20Letter%20one.pdf ": "ok", "./ORIGI\nNALS/(1)%20Letter%20one.pdf": "ok"}
        for value, status in cases.items():
            with self.subTest(value=value):
                self.assertEqual(index.resolve(value)["status"], status)

    def test_rows_without_a_ref_are_reported_next_to_duplicate_refs(self):
        """Lane 3 (r2 regression): round 1 raised TypeError when ref-less rows sat beside a duplicated ref."""
        chron = synth.rows(synth.DEFAULT_ROWS + [("OD-001", "ORIGINALS/(2) Invoice two.pdf")])
        chron += [dict(chron[0], n="5", ref=None), dict(chron[0], n="6", ref=None), dict(chron[0], n="7", ref="")]
        inv, summary = self.build_zip(html_entries={"Workspace.html": synth.workspace_html(chron)})
        self.assertEqual(inv["duplicates"]["chronologyRefs"], [{"ref": "OD-001", "rows": ["1", "4"]}])
        self.assertEqual(inv["duplicates"]["chronologyRowsWithoutRef"], ["5", "6", "7"])
        self.assertEqual(summary["duplicates"]["chronologyRowsWithoutRef"], 3)

    def test_refless_rows_never_share_a_target_or_crash(self):
        """Lane 3 (r3 regression): bad2dd1 grouped ref-less rows into targetsSharedByRefs and raised KeyError 'ref'
        when a link object without a ref key sat beside a ref-less row."""
        letter, invoice = "ORIGINALS/(1) Letter one.pdf", "ORIGINALS/(2) Invoice two.pdf"
        chron = synth.rows(synth.DEFAULT_ROWS + [("OD-001", letter), ("X", letter), ("X", invoice), ("X", invoice)])
        chron[4]["ref"] = None
        del chron[5]["ref"]
        chron[6]["ref"] = ""
        extra = {"items": [{"url": chron[0]["url"], "title": "no ref key"}, {"ref": "", "url": "./elsewhere.pdf"},
                           {"ref": None, "url": chron[1]["url"]}]}
        inv, summary = self.build_zip(html_entries={"Workspace.html": synth.workspace_html(chron, extra_data=extra)})
        dup = inv["duplicates"]
        self.assertEqual(dup["chronologyRowsWithoutRef"], ["5", "6", "7"])
        self.assertEqual(summary["duplicates"]["chronologyRowsWithoutRef"], 3)
        self.assertEqual(dup["chronologyRefs"], [{"ref": "OD-001", "rows": ["1", "4"]}])
        self.assertTrue(all(ref for t in dup["targetsSharedByRefs"] for ref in t["refs"]), dup["targetsSharedByRefs"])
        self.assertNotIn(invoice, [t["path"] for t in dup["targetsSharedByRefs"]])
        self.assertEqual(summary["duplicates"]["targetsSharedByRefs"], len(dup["targetsSharedByRefs"]))
        self.assertEqual(inv["urlMismatches"], [])

    def test_drive_pipe_links_escape_and_entries_are_refused(self):
        """Lane 5 (r3 regression): a browser resolves 'C|/etc/x.pdf' to file:///C:/etc/x.pdf, outside the case folder.
        bad2dd1 resolved it to a same-named zip entry, reported it as ok and extracted that entry."""
        files = dict(synth.DEFAULT_FILES)
        files["C|/etc/x.pdf"] = b"%PDF-1.4 decoy\n"
        chron = synth.rows(synth.DEFAULT_ROWS)
        chron[1]["url"] = "C|/etc/x.pdf"
        z = synth.make_zip(self.path("a.zip"), files=files, html_entries={"Workspace.html": synth.workspace_html(chron)})
        src = archive.ZipSource(z)
        self.assertIn("C|/etc/x.pdf", [u["path"] for u in src.unsafe])
        inv, summary = build.build(src)
        row = next(r for r in inv["refs"] if r["ref"] == "OD-002")
        self.assertEqual((row["status"], row["path"]), ("escapes", None))
        self.assertEqual(summary["missing"]["byStatus"], {"escapes": 1})
        archive.extract(src, self.path("tree"))
        self.assertFalse(os.path.lexists(self.path("tree", "C|")))
        index = build.FileIndex(src.entries, [])
        for value in ("C|/etc/x.pdf", "c|\\x.pdf", "C|", " z|/x", "C\t|/x", "C|/x#a", "C:/x"):
            with self.subTest(value=value):
                self.assertIn(index.resolve(value)["status"], ("escapes", "external-scheme"))
        for bad in ("C|/x", "c|x", "C|"):
            with self.subTest(bad=bad), self.assertRaises(archive.UnsafePath):
                archive.check_relpath(bad)

    def html_roles(self, html_entries, pinned=None):
        src = archive.ZipSource(synth.make_zip(self.path("a.zip"), html_entries=html_entries))
        inv, _summary = build.build(src, pinned) if pinned else build.build(src)
        return {c["path"]: c["role"] for c in inv["html"]["candidates"]}

    def test_main_html_ignores_build_dates_and_names(self):
        """Lane 6 (r2 regression): a variant stamped later, or with no build date, is still the variant.
        Round 1 ranked by builtAt first and picked the variant in both cases."""
        full = synth.rows(synth.DEFAULT_ROWS)
        for variant_built in ("2030-01-02 09:00", None):
            with self.subTest(variant_built=variant_built):
                roles = self.html_roles({"A.html": synth.workspace_html(full, built="2030-01-02 03:04"),
                                         "B.html": synth.workspace_html(full[:2], built=variant_built)})
                self.assertEqual(roles, {"A.html": "main", "B.html": "variant"})

    def test_main_html_fails_instead_of_promoting_a_variant(self):
        """Lane 6 and lane 2 (r2 regression): absent, unreadable or tied main HTML stops the build."""
        full, part = synth.rows(synth.DEFAULT_ROWS), synth.rows(synth.DEFAULT_ROWS[:2])
        variant = synth.workspace_html(part, built="2030-01-02 01:00")
        pinned = {"main": "0" * 64, "variants": [html.parse(variant).sha256]}
        other = synth.rows([("OD-001", "ORIGINALS/(1) Letter one.pdf"), ("OD-009", ""), ("OD-008", "")])
        cases = {
            "pinned main absent": ({"Workspace (update only).html": variant}, pinned),
            "main unreadable": ({"Workspace.html": b"<html>corrupt</html>", "Workspace (update only).html": variant}, None),
            "tie": ({"A.html": synth.workspace_html(full), "B.html": synth.workspace_html(full, built="2030-01-03 00:00")}, None),
            "unrelated refs": ({"A.html": synth.workspace_html(full), "B.html": synth.workspace_html(other)}, None),
        }
        for name, (entries, pin) in cases.items():
            with self.subTest(name), self.assertRaises(build.MainHtmlError):
                self.html_roles(entries, pin)
        self.assertEqual(self.html_roles({"A.html": synth.workspace_html(part), "B.html": variant},
                                         {"main": html.parse(variant).sha256, "variants": []}),
                         {"A.html": "variant", "B.html": "main"})

    def test_main_html_is_chosen_by_content_not_name(self):
        """Lane 6: the later, larger build is main even when its name looks like the variant's."""
        full = synth.workspace_html(synth.rows(synth.DEFAULT_ROWS), built="2030-01-02 03:04")
        early = synth.workspace_html(synth.rows(synth.DEFAULT_ROWS[:2]), built="2030-01-02 01:00")
        inv, summary = self.build_zip(html_entries={"Workspace.html": early, "Workspace (update only).html": full})
        roles = {c["path"]: c["role"] for c in inv["html"]["candidates"]}
        self.assertEqual(roles, {"Workspace.html": "variant", "Workspace (update only).html": "main"})
        diff = inv["html"]["variantDiffs"][0]
        self.assertEqual((diff["refsOnlyInMain"], diff["sameAppCode"], diff["builtAtEarlier"]), (1, True, True))
        self.assertEqual(diff["refPrefixesOnlyInMain"], {"EM": 1})
        self.assertEqual(summary["mainHtml"]["docCount"], 3)

    def test_views_are_counted_from_code(self):
        """Lane 7 (synthetic): handler sites, exports, stores and datasets per view; the last definition wins."""
        _inv, summary = self.build_zip()
        v = summary["views"]["perView"]
        self.assertEqual(summary["views"]["defined"], 3)
        self.assertEqual(summary["views"]["redefinedViews"], ["deadlines_tab"])
        self.assertEqual((v["overview"]["handlerSites"], v["chronology"]["handlerSites"],
                          v["deadlines_tab"]["handlerSites"]), (1, 2, 2))
        self.assertEqual((v["overview"]["navigationSites"], v["chronology"]["navigationSites"]), (1, 0))
        self.assertEqual(v["chronology"]["exportFiles"], ["ess_dcs_chronology.csv"])
        self.assertEqual(v["chronology"]["stores"], ["ess_dcs_rescan_v1"])
        self.assertEqual(v["chronology"]["datasets"], ["DATA.chronology"])
        self.assertEqual(v["deadlines_tab"]["stores"], ["ess_dcs_deadlines_v1"])
        self.assertEqual(summary["views"]["storeKeysNotInBackup"], ["ess_dcs_rescan_v1"])
        self.assertEqual(summary["views"]["backupKeysUnusedElsewhere"], ["ess_dcs_legacy_v1"])


class ExamplesTest(unittest.TestCase):
    def test_money_format(self):
        self.assertEqual(examples.fmt_r(1234567.005), "R 1 234 567.00")
        self.assertEqual(examples.fmt_r(-5), "-R 5.00")
        self.assertEqual(examples.fmt_r(999.999), "R 1 000.00")

    def test_deadline_countdown_under_fixed_clock(self):
        """Lane 9 (synthetic): the countdown badge depends only on the fixed date."""
        today = dt.date(2026, 10, 8)
        got = [examples.countdown(d, today) for d in ("2026-10-01", "2026-10-08", "2026-10-15", "2026-10-16", "")]
        self.assertEqual([g["text"] for g in got], ["7d ago", "today", "in 7d", "in 8d", "—"])
        self.assertEqual([g["badge"] for g in got], ["b-mut", "b-dang", "b-warn", "b-ok", "b-mut"])

    def test_deadline_delete_source_defect(self):
        store = [{"title": "later", "date": "2026-12-03"}, {"title": "earlier", "date": "2026-11-01"}]
        self.assertEqual(examples.deadline_delete_source(store, 0), [store[1]])
        self.assertEqual(examples.deadline_delete_rewrite(store, 0), [store[0]])

    def test_ledger_ignores_empty_add(self):
        got = examples.ledger_apply(["a", "b"], [{"op": "add", "values": {"a": 1}}, {"op": "add", "values": {}},
                                                 {"op": "add", "values": {"b": "x"}}, {"op": "delete", "index": 0}])
        self.assertEqual(got, [{"a": "", "b": "x"}])

    def test_interest(self):
        simple = examples.interest(100000, 10, "Simple", "2004-02-03", "2005-02-03")
        compound = examples.interest(100000, 10, "Compound (monthly)", "2004-02-03", "2005-02-03")
        self.assertEqual((simple["interest"], compound["interest"]), ("R 10 020.53", "R 10 493.90"))

    def test_prescription_add_years(self):
        self.assertEqual(examples.add_years("2004-02-29", 3), "2007-02-28")
        self.assertEqual(examples.add_years("2005-03-31", 3), "2008-03-31")


class RedactTest(unittest.TestCase):
    def test_finds_dates_in_every_written_form(self):
        text = ("a 2001-02-03 b 2001/02/03 c 20010203T090000 d 3/2/2001 e 3.2.2001 f 3 February 2001 "
                "g 3rd of Feb. 2001 h February 3, 2001 i 2026-10-08T09:00:00Z")
        found = [sorted(isos) for _s, _e, isos in redact.find_dates(text)]
        self.assertEqual(found, [["2001-02-03"]] * 3 + [["2001-02-03", "2001-03-02"]] * 2 + [["2001-02-03"]] * 3
                         + [["2026-10-08"]])

    def test_ignores_numbers_that_are_not_dates(self):
        for text in ("version 3.14.7", "sha256 ac25b49620010203ff", "2001-13-40", "R 1 234 567.50", "1,689 rows"):
            with self.subTest(text=text):
                self.assertEqual(list(redact.find_dates(text)), [])

    def test_redacts_case_names_and_every_date_but_the_allowed_ones(self):
        got = redact.redact("Built 2026-08-12; Org X Ltd invoice dated 3 February 2001 (OD-001).", ["org x ltd"])
        self.assertEqual(got, "Built 2026-08-12; <case-name> invoice dated <case-date> (OD-001).")
        self.assertEqual(redact.redact_dates("from 2001-02-03", allowed={"2001-02-03"}), "from 2001-02-03")

    def test_leak_scan_reports_case_dates_in_any_form(self):
        pattern = __import__("re").compile("org x ltd")
        text = "ok 2026-10-08\nleak 2001-02-03\nleak 3 February 2001\nnot a case date 2002-02-03\nOrg X Ltd\n"
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(leak_check.scan("t", text, pattern, {"2001-02-03"}), 3)
        self.assertNotIn("2001-02-03", printed.getvalue())  # hits print a hash, never the value


class ActionCountTest(Temp):
    SECTION = """## Summary

| # | View (id) | Group | Owner | Imported datasets | User-work stores | Actions | Fields | Handler sites | Nav sites | Exports |
| --: | --- | --- | --- | --- | --- | --: | --: | --: | --: | --- |
| 1 | One (`one`) | G | CC-00 | none | none | {n} | 1 | 2 | 0 | none |

Totals: {n} actions and 1 form fields across the 1 views (0 more actions in the shared shell).

## One (`one`)

- **Actions ({n}):**
  - button "Add" → adds (`add 1`)
  - link "open" → opens (`docLink 2`)
- **Form fields (1):**
  - input "Name" → read by add (`none`)
- **Exports:** none
"""

    def write(self, n):
        p = self.path("checklist.md")
        pathlib.Path(p).write_text(self.SECTION.replace("{n}", str(n)))
        return p

    def test_counts_bullets_and_checks_the_declared_totals(self):
        result = count_actions.check(self.write(2))
        self.assertEqual((result["errors"], result["actions"], result["fields"]), ([], 2, 1))

    def test_reports_a_declared_count_that_differs_from_the_bullets(self):
        errors = count_actions.check(self.write(3))["errors"]
        self.assertTrue(any("one" in e and "3" in e for e in errors), errors)


class CliTest(Temp):
    """The CLI against a synthetic archive with its own profile, committed summary and examples."""

    def setUp(self):
        super().setUp()
        self.zip = synth.make_zip(self.path("case.zip"), unflagged=("CORRESPONDENCE/Ünïcode – mail.eml",))
        self.root = self.path("fixtures")
        ex_dir = os.path.join(self.root, "synthetic", "expected")
        os.makedirs(ex_dir)
        self.examples = os.path.join(ex_dir, "expected-examples.json")
        spec = {"examples": [
            {"key": "filter", "kind": "chronology-filter", "input": {"filter": {"q": "invoice"}},
             "expect": {"source": {"count": 1, "firstRefs": ["OD-002"], "lastRef": "OD-002"}, "rewrite": None}},
            {"key": "cite", "kind": "citation", "input": {"field": "DATA.timeline.events[0]"},
             "expect": {"source": None, "rewrite": None}},
            {"key": "deadline", "kind": "deadline", "input": {"today": "2026-10-08", "store": [{"title": "t", "date": "2026-10-09"}]},
             "expect": {"source": {"table": [{"date": "2026-10-09", "title": "t", "text": "in 1d", "badge": "b-warn"}]},
                        "rewrite": None}},
        ]}
        content = b"%PDF-1.4 letter one\n"
        spec["examples"][1]["expect"]["source"] = {
            "ref": "OD-001", "citedUrl": "./ORIGINALS/%281%29%20Letter%20one.pdf",
            "chronologyUrl": "./ORIGINALS/%281%29%20Letter%20one.pdf", "path": "ORIGINALS/(1) Letter one.pdf",
            "status": "ok", "size": len(content), "crc32": f"{__import__('zlib').crc32(content):08x}",
            "sha256": hashlib.sha256(content).hexdigest()}
        raw = json.dumps(spec).encode()
        pathlib.Path(self.examples).write_bytes(raw)
        self.summary = self.path("summary.json")
        self.profile = self.path("profile.json")
        z = pathlib.Path(self.zip).read_bytes()
        ws = html.parse(zipfile.ZipFile(self.zip).read("Workspace.html"))
        pathlib.Path(self.profile).write_text(json.dumps({"archive": {"sha256": hashlib.sha256(z).hexdigest(), "size": len(z), "entries": 6},
                   "mainHtml": {"path": "Workspace.html", "sha256": ws.sha256, "size": ws.size, "builtAt": "2030-01-02 03:04",
                                "docCount": 3, "chronologyRows": 3, "navEntries": 3, "navGroups": 2},
                   "variants": [], "missingLinks": 0, "expectedExamplesSha256": hashlib.sha256(raw).hexdigest()}))

    def cli(self, *extra):
        cmd = [sys.executable, CLI, "--archive", self.zip, "--fixture-root", self.root, "--name", "synthetic",
               "--profile", self.profile, "--summary", self.summary, *extra]
        return subprocess.run(cmd, capture_output=True, text=True)

    def test_verify_extract_tree_and_determinism(self):
        r = self.cli("--write-summary")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        r1 = self.cli("--verify")
        self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
        self.assertIn("verify: PASS", r1.stdout)
        out = os.path.join(self.root, "synthetic", "inventory")
        first = {n: pathlib.Path(os.path.join(out, "zip", n)).read_bytes() for n in ("inventory.json", "summary.json", "examples.json")}
        self.assertEqual(self.cli("--verify").returncode, 0)
        second = {n: pathlib.Path(os.path.join(out, "zip", n)).read_bytes() for n in first}
        self.assertEqual(first, second)
        r2 = self.cli("--extract", "--source", "tree", "--verify")
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        for n in first:
            self.assertEqual(first[n], pathlib.Path(os.path.join(out, "tree", n)).read_bytes(), n)
        run = json.loads(pathlib.Path(out, "zip", "run.json").read_text())
        self.assertGreater(run["peakRssKiB"], 0)
        self.assertEqual(run["zipNames"]["utf8WithoutFlag"], 1)

    def test_verify_fails_on_changed_expectation_or_summary(self):
        self.assertEqual(self.cli("--write-summary").returncode, 0)
        spec = json.loads(pathlib.Path(self.examples).read_text())
        spec["examples"][0]["expect"]["source"]["count"] = 2
        pathlib.Path(self.examples).write_text(json.dumps(spec))
        r = self.cli("--verify")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAIL  expected examples sha256", r.stdout)
        self.assertIn("FAIL  example filter", r.stdout)
        os.remove(self.summary)
        self.assertIn("FAIL  committed summary present", self.cli("--verify").stdout)

    def test_absent_pinned_main_stops_the_build(self):
        """Lane 2 and lane 6 (r2 regression): round 1 exited 0 and reported the variant as main."""
        variant = synth.workspace_html(synth.rows(synth.DEFAULT_ROWS[:2]), built="2030-01-02 01:00")
        zip_path = synth.make_zip(self.path("variant-only.zip"), html_entries={"Workspace (update only).html": variant})
        prof = json.loads(pathlib.Path(self.profile).read_text())
        prof["variants"] = [{"label": "update only", "sha256": html.parse(variant).sha256, "docCount": 2}]
        pathlib.Path(self.profile).write_text(json.dumps(prof))
        r = subprocess.run([sys.executable, CLI, "--archive", zip_path, "--fixture-root", self.root, "--name", "synthetic",
                            "--profile", self.profile, "--summary", self.summary], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("refusing to promote", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.root, "synthetic", "inventory", "zip", "summary.json")))

    def test_missing_archive_is_usage_error(self):
        r = subprocess.run([sys.executable, CLI, "--archive", self.path("nope.zip"), "--fixture-root", self.root],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
