"""Read a case archive as a zip file or as an extracted tree, never modifying the source.

Both readers yield the same `Entry` records, so an inventory built from either is identical.
Entry names are validated before use: absolute paths, `..` components, backslashes,
drive letters, NUL bytes, symlinks and duplicate names are rejected as unsafe.
"""
from __future__ import annotations

import hashlib
import os
import stat
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass

CHUNK = 1 << 20
UTF8_FLAG = 0x800


class UnsafePath(ValueError):
    pass


@dataclass(frozen=True)
class Entry:
    path: str
    size: int
    crc32: int
    name_encoding: str  # 'utf8', 'ascii' or 'utf8-unflagged' (UTF-8 bytes stored without the zip UTF-8 flag)


def check_relpath(name: str) -> str:
    """Return `name` if it is a safe relative POSIX path inside the case folder, else raise UnsafePath."""
    if not name:
        raise UnsafePath("empty path")
    if "\x00" in name:
        raise UnsafePath(f"NUL byte in path: {name!r}")
    if "\\" in name:
        raise UnsafePath(f"backslash in path: {name!r}")
    if name.startswith("/"):
        raise UnsafePath(f"absolute path: {name!r}")
    if len(name) >= 2 and name[1] == ":" and name[0].isalpha():
        raise UnsafePath(f"drive-letter path: {name!r}")
    parts = name.rstrip("/").split("/")
    for part in parts:
        if part in ("", ".", ".."):
            raise UnsafePath(f"path component {part!r} in {name!r}")
    return name


def zip_entry_name(info: zipfile.ZipInfo) -> tuple[str, str]:
    """Decode an entry name. Entries without the UTF-8 flag are decoded by zipfile as CP437; when those
    bytes are valid UTF-8 with non-ASCII characters, the archiver wrote UTF-8 without setting the flag."""
    name = info.filename
    if info.flag_bits & UTF8_FLAG:
        return name, "utf8"
    if name.isascii():
        return name, "ascii"
    try:
        return name.encode("cp437").decode("utf-8"), "utf8-unflagged"
    except UnicodeError:
        return name, "cp437"


def _zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    return info.create_system == 3 and stat.S_ISLNK(info.external_attr >> 16)


class ZipSource:
    kind = "zip"

    def __init__(self, path: str):
        self.path = path
        self._zf = zipfile.ZipFile(path)
        self._infos: dict[str, zipfile.ZipInfo] = {}
        self.entries: list[Entry] = []
        self.unsafe: list[dict] = []
        self.directories = 0
        for info in self._zf.infolist():
            name, enc = zip_entry_name(info)
            try:
                if info.orig_filename != info.filename:
                    raise UnsafePath(f"name altered by zipfile sanitizing: {info.orig_filename!r}")
                check_relpath(name)
                if _zip_is_symlink(info):
                    raise UnsafePath(f"symlink entry: {name!r}")
            except UnsafePath as exc:
                self.unsafe.append({"path": name, "reason": str(exc)})
                continue
            if info.is_dir():
                self.directories += 1
                continue
            if name in self._infos:
                self.unsafe.append({"path": name, "reason": "duplicate entry name"})
                continue
            self._infos[name] = info
            self.entries.append(Entry(name, info.file_size, info.CRC, enc))
        self.entries.sort(key=lambda e: e.path)

    def read(self, path: str) -> bytes:
        return self._zf.read(self._infos[path])

    def open(self, path: str):
        return self._zf.open(self._infos[path])

    def close(self):
        self._zf.close()


class TreeSource:
    """An extracted case folder. Symlinks are reported as unsafe and never followed."""

    kind = "tree"

    def __init__(self, root: str, crc: bool = True):
        self.root = os.path.realpath(root)
        self.entries: list[Entry] = []
        self.unsafe: list[dict] = []
        self.directories = 0
        for dirpath, dirnames, filenames in os.walk(self.root, followlinks=False):
            rel_dir = os.path.relpath(dirpath, self.root)
            for name in sorted(dirnames):
                full = os.path.join(dirpath, name)
                if os.path.islink(full):
                    self.unsafe.append({"path": self._rel(rel_dir, name), "reason": "symlink directory"})
                    dirnames.remove(name)
                else:
                    self.directories += 1
            for name in filenames:
                rel = self._rel(rel_dir, name)
                full = os.path.join(dirpath, name)
                st = os.lstat(full)
                if stat.S_ISLNK(st.st_mode):
                    self.unsafe.append({"path": rel, "reason": "symlink file"})
                    continue
                if not stat.S_ISREG(st.st_mode):
                    self.unsafe.append({"path": rel, "reason": "not a regular file"})
                    continue
                try:
                    rel.encode("utf-8")
                except UnicodeError:
                    self.unsafe.append({"path": rel.encode("utf-8", "surrogateescape").decode("utf-8", "replace"),
                                        "reason": "name is not valid UTF-8"})
                    continue
                self.entries.append(Entry(rel, st.st_size, file_crc32(full) if crc else -1, "utf8"))
        self.entries.sort(key=lambda e: e.path)
        self.unsafe.sort(key=lambda u: u["path"])

    @staticmethod
    def _rel(rel_dir: str, name: str) -> str:
        return name if rel_dir == "." else f"{rel_dir}/{name}"

    def _full(self, path: str) -> str:
        check_relpath(path)
        return os.path.join(self.root, path)

    def read(self, path: str) -> bytes:
        with open(self._full(path), "rb") as fh:
            return fh.read()

    def open(self, path: str):
        return open(self._full(path), "rb")

    def close(self):
        pass


def file_crc32(path: str) -> int:
    crc = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(CHUNK):
            crc = zlib.crc32(chunk, crc)
    return crc


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def is_nfc(path: str) -> bool:
    return unicodedata.is_normalized("NFC", path)


def _check_inside(root: str, path: str, name: str):
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        raise RuntimeError(f"refusing to write outside {root}: {name}")


def extract(src: ZipSource, dest: str) -> dict:
    """Extract every safe entry into `dest`, verifying size and CRC-32 against the zip.

    Existing files with the right size and CRC are kept; anything else is an error. Unsafe entries are
    never written. Files are written read-only. Returns counts; raises RuntimeError on any mismatch."""
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    written = kept = 0
    for entry in src.entries:
        target = os.path.join(root, entry.path)
        parent = os.path.dirname(target)
        # Check before creating anything: realpath resolves any symlinked directory already in the tree.
        _check_inside(root, parent, entry.path)
        os.makedirs(parent, exist_ok=True)
        _check_inside(root, parent, entry.path)
        if os.path.lexists(target):
            st = os.lstat(target)
            if not stat.S_ISREG(st.st_mode) or st.st_size != entry.size or file_crc32(target) != entry.crc32:
                raise RuntimeError(f"existing file differs from the archive: {entry.path}")
            kept += 1
            continue
        part = target + ".part"
        crc, size = 0, 0
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, "wb") as out, src.open(entry.path) as inp:
                while chunk := inp.read(CHUNK):
                    crc = zlib.crc32(chunk, crc)
                    size += len(chunk)
                    out.write(chunk)
            if size != entry.size or crc != entry.crc32:
                raise RuntimeError(f"size/CRC mismatch extracting {entry.path}")
            os.chmod(part, 0o444)
            os.rename(part, target)
        except BaseException:
            if os.path.lexists(part):
                os.unlink(part)
            raise
        written += 1
    return {"written": written, "kept": kept, "files": len(src.entries), "unsafeSkipped": len(src.unsafe)}
