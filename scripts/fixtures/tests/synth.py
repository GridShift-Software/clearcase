"""Build small synthetic v5-shaped archives for the tests. Every name and value here is invented."""
from __future__ import annotations

import json
import os
import stat
import zipfile

NAV = """const NAV=[
  ['Matter',[['overview','Overview','i'],['chronology','Chronology','i']]],
  ['System',[['deadlines_tab','Deadlines','i']]],
];"""

APP = r"""
const STORE_KEYS=['ess_dcs_deadlines_v1','ess_dcs_legacy_v1'];
const RKEY='ess_dcs_rescan_v1';
const RENDER={};
function load(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v));}
function dl(n,c){/* download */}
function allRows(){return DATA.chronology.concat(load(RKEY,[]));}
RENDER.overview=function(el){el.innerHTML='<a onclick="go(\'chronology\')">{x}</a><a data-tab="chronology">y</a>'+META.docCount;};
RENDER.chronology=function(el){el.innerHTML='<input oninput="draw()"><button onclick="exportChron()">CSV</button>';draw();};
function draw(){const a=allRows().filter(r=>/[}]/.test(r.ref)||true);return a.length;}
function exportChron(){dl('ess_dcs_chronology.csv','x');}
RENDER.deadlines_tab=function(el){el.innerHTML='old';};
RENDER.deadlines_tab=function(el){const s=load('ess_dcs_deadlines_v1',[]);
  el.innerHTML='<button onclick="addDl()">Add</button>';document.body.addEventListener('keydown',()=>{});};
function addDl(){save('ess_dcs_deadlines_v1',[]);}
"""

DEFAULT_FILES = {
    "ORIGINALS/(1) Letter one.pdf": b"%PDF-1.4 letter one\n",
    "ORIGINALS/(2) Invoice two.pdf": b"%PDF-1.4 invoice two\n",
    "CORRESPONDENCE/Ünïcode – mail.eml": b"From: a@example.invalid\n\nsynthetic\n",
    "CORRESPONDENCE/copy of letter one.pdf": b"%PDF-1.4 letter one\n",
    "Extra Folder/notes.txt": b"synthetic notes\n",
}


def rows(refs_and_paths):
    out = []
    for i, (ref, path) in enumerate(refs_and_paths, 1):
        url = "./" + "/".join(__import__("urllib.parse").parse.quote(p) for p in path.split("/")) if path else ""
        out.append({"n": str(i), "ref": ref, "date": f"2001-02-{i:02d}", "filename": path.rsplit("/", 1)[-1],
                    "subject": f"Synthetic subject {i}", "sender": "", "doc_type": "letter",
                    "bundle": "Original", "amount": "", "text_status": "extracted", "url": url,
                    "attachments": [], "excerpt": ""})
    return out


def workspace_html(chronology, built="2030-01-02 03:04", extra_data=None, nav=NAV, app=APP) -> bytes:
    """`built=None` leaves META.builtAt out."""
    data = {"chronology": chronology, "timeline": {"events": [
        {"ref": chronology[0]["ref"], "url": chronology[0]["url"], "title": "Synthetic event"}]}}
    data.update(extra_data or {})
    meta = {"docCount": len(chronology), "bundles": {"Original": len(chronology)}}
    if built is not None:
        meta["builtAt"] = built
    lines = ["<!DOCTYPE html>", "<html><body><main id=main></main>", "<script>",
             "const DATA = " + json.dumps(data, ensure_ascii=False) + ";",
             "const META = " + json.dumps(meta, ensure_ascii=False) + ";",
             nav, app, "</script>", "</body></html>"]
    return "\n".join(lines).encode("utf-8")


DEFAULT_ROWS = [("OD-001", "ORIGINALS/(1) Letter one.pdf"), ("OD-002", "ORIGINALS/(2) Invoice two.pdf"),
                ("EM-0001", "CORRESPONDENCE/Ünïcode – mail.eml")]


def make_zip(path, files=None, html_entries=None, unflagged=(), raw_entries=()):
    """Write a stored zip. `unflagged` names are written as UTF-8 bytes without the UTF-8 flag, as some
    archivers do. `raw_entries` are (ZipInfo, bytes) pairs written as given (for unsafe-entry tests)."""
    files = dict(DEFAULT_FILES if files is None else files)
    if html_entries is None:
        html_entries = {"Workspace.html": workspace_html(rows(DEFAULT_ROWS))}
    files.update(html_entries)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as zf:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.create_system = 3
            zf.writestr(info, files[name])
        for info, data in raw_entries:
            zf.writestr(info, data)
    if unflagged:
        _clear_utf8_flag(path, unflagged)
    return path


def _clear_utf8_flag(path, names):
    """Rewrite the zip so the given names are stored as raw UTF-8 bytes with flag bit 11 cleared."""
    with zipfile.ZipFile(path) as zf:
        items = [(i, zf.read(i)) for i in zf.infolist()]
    with open(path, "wb") as raw:
        offsets = []
        for info, data in items:
            name = info.filename.encode("utf-8")
            flag = 0 if info.filename in names else (0x800 if not info.filename.isascii() else 0)
            offsets.append((raw.tell(), name, flag, info, data))
            raw.write(b"PK\x03\x04" + _le(20, 2) + _le(flag, 2) + _le(0, 2) + _le(0, 2) + _le(0x5A21, 2)
                      + _le(info.CRC, 4) + _le(len(data), 4) + _le(len(data), 4) + _le(len(name), 2) + _le(0, 2)
                      + name + data)
        cd = raw.tell()
        for off, name, flag, info, data in offsets:
            raw.write(b"PK\x01\x02" + _le(0x031E, 2) + _le(20, 2) + _le(flag, 2) + _le(0, 2) + _le(0, 2)
                      + _le(0x5A21, 2) + _le(info.CRC, 4) + _le(len(data), 4) + _le(len(data), 4)
                      + _le(len(name), 2) + _le(0, 2) + _le(0, 2) + _le(0, 2) + _le(0, 2)
                      + _le(info.external_attr, 4) + _le(off, 4) + name)
        end = raw.tell()
        raw.write(b"PK\x05\x06" + _le(0, 2) + _le(0, 2) + _le(len(offsets), 2) + _le(len(offsets), 2)
                  + _le(end - cd, 4) + _le(cd, 4) + _le(0, 2))


def _le(n, size):
    return n.to_bytes(size, "little")


def symlink_info(name, target="/etc/passwd"):
    info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    return info, target.encode()


def write_tree(root, files):
    for name, data in files.items():
        p = os.path.join(root, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(data)
