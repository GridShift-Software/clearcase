"""ClearCase agent tooling: doctor, plan checks, verification capabilities and receipts.

Standard library only. Entry points are the bash wrappers next to this file;
see docs/agent-tooling.md for invocation, exit codes and the receipt format.
"""

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parents[1]
LOCK_PATH = TOOLS_DIR / "skills.lock.json"
HOME = os.environ.get("HOME", "")
SKIPPED = 3
MIN_NODE = (18, 0)
MIN_PYTHON = (3, 10)
MIN_BASH = (4, 4)
# The app's minimum Bun until GRS-10 adds package.json, whose packageManager then replaces it. Move it only in a
# reviewed commit, after bun upgrade --stable; see docs/agent-tooling.md.
MIN_BUN = "1.4.2"
SEMVER = re.compile(r"v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
FULL_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
# The project verification skill (GRS-12): its runner drives the built app offline in Chromium. The doctor checks its
# prerequisites before any install or build; verify app runs it. See docs/agent-tooling.md, App verification.
APP_RUNNER = Path(".agents/skills/verify-clearcase/bin/verify-clearcase")
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
IGNORED_PARTS = {"node_modules", "__pycache__", ".DS_Store"}


def redact(value):
    text = str(value)
    return text.replace(HOME, "~") if HOME and HOME != "/" else text


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def excerpt(output):
    """Command output, bytes, as one line of at most 300 characters."""
    detail = " ".join(output.decode(errors="backslashreplace").split())
    return f"{detail[:300]}..." if len(detail) > 300 else detail


def ended(argv, code, stderr):
    """How an evidence command that did not succeed ended, for a reason: the command, its exit code and its stderr."""
    how = f"exited {code}" if code >= 0 else f"was killed by signal {-code}"
    return f"`{' '.join(redact(part) for part in argv)}` {how}: {excerpt(stderr) or 'no error output'}"


def failed(error, path):
    """'PATH: why' for an OSError raised while reading path."""
    return f"{redact(path)}: {error.strerror or error}"


def version_probe(argv):
    """Run a version probe, as (stdout, stderr, problem). problem is None only when it exits 0 within 30 seconds."""
    try:
        out = subprocess.run(argv, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        return b"", b"", f"`{' '.join(redact(part) for part in argv)}` did not run: {redact(error)}"
    return out.stdout, out.stderr, ended(argv, out.returncode, out.stderr) if out.returncode else None


def first_line(argv):
    """The first line a version probe prints, as (line, problem). problem is None only when it exits 0 and prints."""
    stdout, stderr, problem = version_probe(argv)
    text = (stdout or stderr).decode(errors="backslashreplace").strip().splitlines()
    if problem or not text:
        return None, problem or f"`{redact(argv[0])}` printed no version"
    return text[0], None


def whole_stdout(argv):
    """All a version probe prints on stdout, stripped but never cut to its first line, as (text, problem), for a
    caller that requires exactly one version line. Output on stderr is a problem even with exit 0."""
    stdout, stderr, problem = version_probe(argv)
    if not problem and stderr.strip():
        problem = f"`{' '.join(redact(part) for part in argv)}` wrote to stderr: {excerpt(stderr)}"
    text = stdout.decode(errors="backslashreplace").strip()
    if problem or not text:
        return None, problem or f"`{redact(argv[0])}` printed no version on stdout"
    return text, None


def which(name):
    """Only CLEARCASE_PYTHON, CLEARCASE_NODE and CLEARCASE_BUN override discovery, so the git a receipt lists is the
    git it used."""
    override = name in ("python3", "node", "bun") and os.environ.get(f"CLEARCASE_{name.upper().replace('3', '')}")
    if override:
        return override if os.access(override, os.X_OK) else None
    if name == "python3":
        return sys.executable
    return shutil.which(name)


def parse_version(text):
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    return tuple(int(part) for part in match.groups() if part is not None) if match else None


def tool_info(name):
    """A receipt's tools row as (row, problem). problem names a version probe that failed; a missing tool has none.
    Bun's version is its whole stdout, which the doctor requires to be one version line, and Bun output on stderr is a
    problem. Other tools give the first line they print."""
    path = which(name)
    if not path:
        return {"name": name, "path": None, "version": None}, None
    argv = [path, "-V" if name == "tmux" else "--version"]
    version, problem = whole_stdout(argv) if name == "bun" else first_line(argv)
    return {"name": name, "path": redact(path), "version": version}, problem


def file_identity(path):
    """The identity of a regular file: the sha256 of its bytes and the size, modification time, device and inode of
    the file they were read from, through one descriptor. Raises OSError when it cannot be read, is not a regular
    file or changes while it is read, so a fingerprint is always of bytes that were read whole."""
    with open(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise OSError("not a regular file")
        digest, size = hashlib.sha256(), 0
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
            size += len(block)
        after = os.fstat(handle.fileno())
    if not size == before.st_size == after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise OSError(f"changed while it was read ({before.st_size} bytes by stat, {size} read)")
    return {"sha256": digest.hexdigest(), "size": size, "mtimeNs": before.st_mtime_ns, "device": before.st_dev,
            "inode": before.st_ino}


def sha256_file(path):
    """sha256 of a regular file's bytes, read whole; raises OSError as file_identity() does."""
    return file_identity(path)["sha256"]


def manifest(directory, ignored=IGNORED_PARTS):
    """Relative path -> file sha256 (or symlink target) in hashing order, without ignored parts. Raises OSError naming
    the entry when a directory or file cannot be read, or is not a file, directory or symlink, so no content is left
    out silently."""
    def unreadable(error):
        raise OSError(failed(error, error.filename))
    found = []
    for top, dirs, files in os.walk(directory, onerror=unreadable):
        dirs[:] = [name for name in dirs if name not in ignored]
        found += [Path(top, name) for name in files] + [Path(top, name) for name in dirs if Path(top, name).is_symlink()]
    rows = {}
    for path in sorted(found):
        rel = path.relative_to(directory)
        if ignored.intersection(rel.parts):
            continue
        try:
            rows[rel.as_posix()] = os.fsencode(os.readlink(path)) if path.is_symlink() else bytes.fromhex(sha256_file(path))
        except OSError as error:
            raise OSError(failed(error, path)) from None
    return rows


def rows_hash(rows):
    digest = hashlib.sha256()
    for rel, content in rows.items():
        digest.update(os.fsencode(rel) + b"\0" + content + b"\n")
    return digest.hexdigest()


def tree_hash(directory):
    rows = manifest(directory)
    return rows_hash(rows), len(rows)


def upstream_tree(checkout, revision):
    """plugin.json and skill name -> manifest() rows at a pstack revision, read from Git objects, not the working tree,
    as (plugin, skills, problem). plugin is None when they cannot be read, and problem then holds Git's message."""
    def run(*args, data=None):
        argv = ["git", "--no-replace-objects", "-C", str(checkout), *args]
        return argv, subprocess.run(argv, input=data, capture_output=True)
    if not shutil.which("git"):
        return None, {}, "git not found on PATH"
    argv, listing = run("ls-tree", "-r", "-z", f"{revision}^{{commit}}", "--", "skills", ".cursor-plugin/plugin.json")
    if listing.returncode:
        return None, {}, ended(argv, listing.returncode, listing.stderr)
    blobs = [(meta.split()[0], meta.split()[2], path.decode()) for meta, path in
             (record.split(b"\t", 1) for record in listing.stdout.split(b"\0") if record) if meta.split()[1] == b"blob"]
    argv, batch = run("cat-file", "--batch", data=b"".join(oid + b"\n" for _, oid, _ in blobs))
    out = batch.stdout
    plugin, skills, pos = None, {}, 0
    for mode, oid, path in blobs:
        end = out.find(b"\n", pos)
        header = out[pos:end].split() if end >= 0 else []
        if batch.returncode or len(header) != 3 or header[:2] != [oid, b"blob"]:
            seen = b" ".join(header).decode(errors="replace") or "no object"
            return None, {}, f"cannot read {path} ({oid.decode()}) from its Git objects: {seen}" + (
                f"; {ended(argv, batch.returncode, batch.stderr)}" if batch.returncode else "")
        size = int(header[2])
        content, pos = out[end + 1:end + 1 + size], end + 2 + size
        parts = Path(path).parts
        if path == ".cursor-plugin/plugin.json":
            plugin = content
        elif len(parts) > 2 and parts[0] == "skills" and not IGNORED_PARTS.intersection(parts[2:]):
            value = content if mode == b"120000" else hashlib.sha256(content).digest()
            skills.setdefault(parts[1], []).append((Path(*parts[2:]), value))
    rows = {name: {rel.as_posix(): value for rel, value in sorted(entries)} for name, entries in skills.items()}
    return plugin, {name: files for name, files in rows.items() if "SKILL.md" in files}, None


def upstream_diff(theirs, installed):
    """diff -rq between a skill's upstream rows and its installed directory, with the pin's exclusions."""
    ours = manifest(installed)
    return [f"{rel} {'only upstream' if rel not in ours else 'only installed' if rel not in theirs else 'differs'}"
            for rel in sorted(theirs.keys() | ours.keys()) if theirs.get(rel) != ours.get(rel)]


def os_release():
    try:
        rows = dict(
            line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line
        )
        return rows.get("PRETTY_NAME", "").strip('"'), rows.get("ID", "").strip('"')
    except OSError:
        return "unknown", "unknown"


def environment():
    pretty, _ = os_release()
    return {
        "os": pretty,
        "platform": sys.platform,
        "kernel": platform.release(),
        "machine": platform.machine(),
        "host": platform.node(),
        "bash": os.environ.get("CLEARCASE_BASH_VERSION"),
        "callerShell": redact(os.environ.get("SHELL", "")),
        "python": platform.python_version(),
        "path": redact(os.environ.get("PATH", "")),
    }


def git(root, *args, quiet=False):
    """Run the git on PATH in root as (exit code, stdout bytes, problem). problem is None only for exit 0, and with
    quiet also only without stderr; otherwise it names the command, its exit code and its stderr, in English.
    Inherited GIT_* variables such as GIT_DIR are dropped, so they cannot redirect it."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")} | {"LC_ALL": "C"}
    try:
        out = subprocess.run([shutil.which("git") or "git", "-C", str(root), *args], capture_output=True, env=env)
    except OSError as error:
        return None, b"", f"`git {' '.join(args)}` did not run: {error}"
    failed_query = out.returncode or (quiet and out.stderr.strip())
    return out.returncode, out.stdout, ended(["git", *args], out.returncode, out.stderr) if failed_query else None


def commit_of(root, ref):
    """The full commit ID that ref names in root, as (commit, problem). Both are None only when ref names nothing,
    the one case in which a caller may try another ref."""
    code, out, problem = git(root, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}")
    commit = out.decode(errors="replace").strip()
    if code == 0:
        return (commit, None) if FULL_ID.fullmatch(commit) else (None, f"git printed {commit!r} for {ref}, not a commit ID")
    if code != 1:
        return None, problem
    code, out, problem = git(root, "rev-parse", "--verify", "-q", ref)
    if code == 1:
        return None, None
    return None, problem or f"{ref} names {out.decode(errors='replace').strip()}, which is not a commit Git can read"


def worktree_state(root):
    """(dirty, diffSha256, problem) for root. The digest covers the tracked diff against HEAD, without external diff
    drivers or textconv filters that could hide a change, and each untracked file that is not ignored: its bytes, a
    symlink's target or a nested repository's files. Any of the three outputs makes root dirty, so configuration
    such as status.showUntrackedFiles cannot hide a change. A Git query that fails or warns, as it does with exit 0
    for a directory it cannot open, a tracked file Git is told not to check (assume-unchanged or skip-worktree), or a
    file that cannot be read is the problem, so a state that was not read is never reported as clean."""
    queries = [("status", "--porcelain"),
               ("diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"),
               ("ls-files", "-z", "--others", "--exclude-standard"),
               ("ls-files", "-z", "-v")]
    outputs = []
    for args in queries:
        _, out, problem = git(root, *args, quiet=True)
        if problem:
            return None, None, problem
        outputs.append(out)
    status, diff, listing, tags = outputs
    unchecked = [entry[2:] for entry in tags.split(b"\0") if entry[:1].islower() or entry[:1] == b"S"]
    if unchecked:
        return None, None, (f"git does not check {len(unchecked)} tracked files marked assume-unchanged or "
                            f"skip-worktree, for example {os.fsdecode(unchecked[0])}; clear the marks with "
                            "git update-index --no-assume-unchanged or --no-skip-worktree")
    untracked = [name for name in listing.split(b"\0") if name]
    digest = hashlib.sha256(diff)
    for name in untracked:
        path = Path(root) / os.fsdecode(name)
        try:
            content = (os.fsencode(os.readlink(path)) if path.is_symlink()
                       else bytes.fromhex(rows_hash(manifest(path, frozenset()))) if path.is_dir()
                       else bytes.fromhex(sha256_file(path)))
        except OSError as error:
            return None, None, f"untracked {failed(error, path)} (listed by `git ls-files --others`, then not read)"
        digest.update(name + b"\0" + content)
    dirty = bool(status.strip() or diff or untracked)
    return dirty, digest.hexdigest() if dirty else None, None


def revision(root, base_ref=None):
    """Git identity of root as (fields, problem). Only a None problem lets a receipt PASS, so every PASS receipt
    names head, base and mergeBase and a working-copy state that Git reported. An explicit base (--base or
    CLEARCASE_BASE_REF), even an empty one, never falls back to a default, and neither does a default that names
    something unreadable."""
    explicit = base_ref if base_ref is not None else os.environ.get("CLEARCASE_BASE_REF")
    fields = {"repository": False, "root": redact(root), "branch": None, "head": None, "baseRef": explicit,
              "base": None, "mergeBase": None, "dirty": None, "diffSha256": None}
    if not shutil.which("git"):
        return fields, "required tool not found: git; install git and put it on PATH"
    _, out, problem = git(root, "rev-parse", "--show-toplevel")
    top = os.fsdecode(out.rstrip(b"\n")) if not problem else None
    if not top or Path(top).resolve() != Path(root).resolve():
        where = (f"{redact(root)} is inside {redact(top)} but is not its top" if top
                 else f"Git cannot read {redact(root)} as a checkout ({problem or 'it printed no top level'})")
        return fields, f"no head revision: {where}; run from a ClearCase checkout or worktree, or pass --root DIR at the top of one"
    head, problem = commit_of(root, "HEAD")
    if not head:
        return fields, f"no head revision: {problem}; check the repository with git fsck" if problem else (
            f"no head revision: {redact(root)} has no commit yet")
    _, out, problem = git(root, "rev-parse", "--abbrev-ref", "HEAD")
    fields.update(repository=True, head=head, branch=None if problem else out.decode(errors="backslashreplace").strip())
    if problem:
        return fields, f"branch unknown: {problem}"
    dirty, digest, problem = worktree_state(root)
    if problem:
        return fields, f"working tree state unknown: {problem}"
    fields.update(dirty=dirty, diffSha256=digest)
    fix = "pass --base REF, the accepted revision this branch was cut from"
    for ref in [explicit] if explicit is not None else ["origin/dev", "dev"]:
        base, problem = commit_of(root, ref) if ref else (None, None)
        if base or problem:
            break
    if problem:
        return fields, f"base {ref!r} does not resolve to a commit in {redact(root)}: {problem}; {fix}"
    if not base:
        return fields, (f"base {explicit!r} does not resolve to a commit in {redact(root)}; {fix}" if explicit is not None
                        else f"no base revision: neither origin/dev nor dev exists in {redact(root)}; {fix}")
    fields.update(baseRef=ref, base=base)
    code, out, problem = git(root, "merge-base", head, base)
    merge_base = out.decode(errors="replace").strip()
    if code == 1 and not merge_base:
        return fields, f"base {ref} ({base[:12]}) shares no history with HEAD {head[:12]}; {fix}"
    if problem or not FULL_ID.fullmatch(merge_base):
        return fields, f"no merge base: {problem or f'git printed {merge_base!r}, not a commit ID'}"
    fields.update(mergeBase=merge_base)
    return fields, None


def receipts_root(explicit=None):
    chosen = explicit or os.environ.get("CLEARCASE_RECEIPTS_DIR") or REPO / ".local/agent-receipts"
    return Path(chosen).expanduser().resolve()


def tee(source, capture, console, problems, written):
    """Copy source to its capture file and the console until EOF, always draining it so the command cannot block.
    written, a sha256, takes each chunk the capture file accepted. A failed capture write is added to problems and
    ends the capture. A console that stops accepting output is dropped, because only the capture is evidence."""
    for chunk in iter(lambda: source.read1(65536), b""):
        if capture:
            try:
                capture.write(chunk)
                capture.flush()
                written.update(chunk)
            except OSError as error:
                problems.append(failed(error, capture.name))
                capture = None
        if console:
            try:
                console.write(chunk)
                console.flush()
            except OSError:
                console = None
    source.close()


def receipt_folder(receipts, name, started):
    folder = receipts_root(receipts) / f"{started.strftime('%Y%m%dT%H%M%S.%fZ')}-{name}"
    folder.mkdir(parents=True, exist_ok=False)
    return folder


def fingerprints(paths):
    """Receipt input rows, each path with the file_identity() of its file, as (rows, problem). problem names each
    input that is missing or cannot be read whole, whose sha256 and other identity fields are then null."""
    rows, missing, unreadable = [], [], []
    for path in paths:
        found = dict.fromkeys(["sha256", "size", "mtimeNs", "device", "inode"])
        if not Path(path).is_file():
            missing.append(redact(path))
        else:
            try:
                found = file_identity(path)
            except OSError as error:
                unreadable.append(failed(error, path))
        rows.append({"path": redact(Path(path).resolve()), **found})
    return rows, ((missing and f"required input not found: {', '.join(missing)}")
                  or (unreadable and f"input not fingerprinted: {'; '.join(unreadable)}") or None)


def inputs_changed(paths, rows):
    """The second look at the inputs that fingerprints() made rows of before the run: each one that was removed,
    replaced or changed since, or cannot be read whole now, as a reason, or None. A change undone between the two
    looks goes unseen; see "What receipts prove" in docs/agent-tooling.md."""
    problems = []
    for path, row in zip(paths, rows):
        try:
            now = file_identity(path)
        except OSError as error:
            problems.append(failed(error, path))
            continue
        differ = [f"{key} {str(row[key])[:12]} -> {str(now[key])[:12]}" if key == "sha256" else
                  f"{key} {row[key]} -> {now[key]}" for key in now if now[key] != row[key]]
        if differ:
            problems.append(f"{redact(path)}: {', '.join(differ)}")
    return "; ".join(problems) or None


def revision_changed(root, base_ref, before):
    """The second look at the revision() fields recorded before the run, as a reason when the head, base, merge base
    or working-tree state changed since, or cannot be read now, or None."""
    after, problem = revision(root, base_ref)
    if problem:
        return f"the revision cannot be read after the run: {problem}"
    differ = [f"{key} {before[key]} -> {after[key]}" for key in ("head", "base", "mergeBase", "dirty", "diffSha256")
              if after[key] != before[key]]
    return f"the checkout changed during the run: {', '.join(differ)}" if differ else None


def capture_lost(capture, written):
    """Why a capture file, still open after the run, does not hold at its path all that was written to it, or None.
    Its descriptor must keep a link and the size written, its path must still name it, and the bytes it holds, read
    through the descriptor, must have the sha256 written, which tee() took of the bytes as it wrote them."""
    held = os.fstat(capture.fileno())
    if held.st_nlink < 1:
        return f"{redact(capture.name)}: removed during the run"
    try:
        named = os.stat(capture.name)
    except OSError as error:
        return f"{failed(error, capture.name)}; it was moved during the run"
    if (named.st_dev, named.st_ino) != (held.st_dev, held.st_ino):
        return f"{redact(capture.name)}: replaced during the run"
    if held.st_size != capture.tell():
        return f"{redact(capture.name)}: holds {held.st_size} bytes, {capture.tell()} were written"
    stored, offset = hashlib.sha256(), 0
    while block := os.pread(capture.fileno(), 1 << 20, offset):
        stored.update(block)
        offset += len(block)
    if stored.digest() != written.digest():
        return (f"{redact(capture.name)}: holds other bytes than were written (sha256 {stored.hexdigest()[:12]}, "
                f"written {written.hexdigest()[:12]})")
    return None


def run_captured(argv, cwd, folder):
    """Run argv, streaming its output live and capturing it in folder, as (exit code, problem). The code is None when
    argv did not start; otherwise problem names output that was not captured whole, or a capture file that lost or
    changed it."""
    code, problems = None, []
    try:
        with open(folder / "stdout.txt", "w+b") as out_file, open(folder / "stderr.txt", "w+b") as err_file:
            child = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            written = [hashlib.sha256(), hashlib.sha256()]
            threads = [threading.Thread(target=tee, args=(child.stdout, out_file, sys.stdout.buffer, problems, written[0])),
                       threading.Thread(target=tee, args=(child.stderr, err_file, sys.stderr.buffer, problems, written[1]))]
            for thread in threads:
                thread.start()
            code = child.wait()
            for thread in threads:
                thread.join()
            if not problems:
                problems += filter(None, map(capture_lost, (out_file, err_file), written))
    except OSError as error:
        if not problems:  # a capture write that failed fails again when its file is closed
            problems.append(failed(error, error.filename or folder))
    return code, "; ".join(problems) or None


def write_receipt(folder, started, name, result, code, reason, argv, cwd, tool_rows, inputs, identity):
    finished = now()
    receipt = {
        "schema": "clearcase-agent-receipt/1",
        "name": name,
        "result": result,
        "exitCode": code,
        "reason": redact(reason) if reason else None,
        "command": [redact(part) for part in argv],
        "cwd": redact(cwd),
        "tools": tool_rows,
        "inputs": inputs,
        "revision": identity,
        "environment": environment(),
        "startedAt": started.isoformat(),
        "finishedAt": finished.isoformat(),
        "durationSeconds": round((finished - started).total_seconds(), 3),
        "artifacts": {
            "receipt": redact(folder / "receipt.json"),
            "stdout": redact(folder / "stdout.txt"),
            "stderr": redact(folder / "stderr.txt"),
        },
    }
    (folder / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    sys.stderr.write(f"receipt: {result} {name} exit={code} {redact(folder / 'receipt.json')}\n")
    sys.stderr.flush()


def run_with_receipt(name, argv, *, cwd=None, tools=(), inputs=(), receipts=None, base=None, root=None,
                     skip_reason=None):
    """Collect the evidence first: the revision, each tool's path and version and each input's identity. Run argv
    only if all of it was collected, stream and capture its output, look at the captures, inputs and revision again
    and write a receipt. Evidence that cannot be collected, or changes during the run, is never PASS. Returns the exit
    code."""
    root = Path(root or REPO)
    started = now()
    try:
        folder = receipt_folder(receipts, name, started)
    except OSError as error:
        sys.stderr.write(f"SKIPPED {name}: cannot create its receipt directory: "
                         f"{failed(error, error.filename or receipts_root(receipts))}; pass --receipts DIR or set "
                         "CLEARCASE_RECEIPTS_DIR to a writable directory. The command did not run.\n")
        return SKIPPED
    probed = [tool_info(tool) for tool in dict.fromkeys(["git", *tools])]
    tool_rows = [row for row, _ in probed]
    unprobed = [problem for _, problem in probed if problem]
    missing = [row["name"] for row in tool_rows if row["path"] is None]
    if argv and not missing and not skip_reason and not (shutil.which(argv[0]) or Path(argv[0]).is_file()):
        missing.append(argv[0])
    identity, unidentified = revision(root, base)
    here = Path(cwd or root).resolve()
    if not unidentified and here != root.resolve():
        _, out, problem = git(here, "rev-parse", "--show-toplevel")
        if problem or Path(os.fsdecode(out.rstrip(b"\n"))).resolve() != root.resolve():
            unidentified = (f"the command would run in {redact(here)}, outside the checkout {redact(root.resolve())} "
                            "whose revision the receipt records; run it inside that checkout, or pass --root DIR "
                            "naming the checkout it runs in")
    rows, unfingerprinted = fingerprints(inputs)
    reason = (skip_reason
              or (missing and f"required tool not found: {', '.join(missing)}; install it or put it on PATH "
                              "(scripts/agent-tools/doctor names the fix)")
              or (unprobed and f"tool version unknown: {'; '.join(unprobed)}")
              or unidentified
              or unfingerprinted
              or None)
    exited, result, code = None, "SKIPPED", SKIPPED
    if not reason:
        exited, problem = run_captured(argv, cwd or root, folder)
        moved = None if exited is None else inputs_changed(inputs, rows)
        shifted = None if exited is None else revision_changed(root, base, identity)
        if exited is None:
            reason = f"the command did not start: {problem}"
        elif problem:
            reason = f"output not captured whole: {problem}; the command exited {exited}"
            result, code = ("FAIL", exited) if exited else ("SKIPPED", SKIPPED)
        elif moved or shifted:
            reason = "; ".join(filter(None, [moved and f"input changed during the run: {moved}", shifted,
                                             f"the command exited {exited}"]))
            result, code = ("FAIL", exited) if exited else ("SKIPPED", SKIPPED)
        else:
            result, code = "PASS" if exited == 0 else "FAIL", exited
    if result == "SKIPPED":
        sys.stderr.write(f"SKIPPED {name}: {redact(reason)}\n")
    try:
        if exited is None:
            (folder / "stdout.txt").write_bytes(b"")
            (folder / "stderr.txt").write_text(f"SKIPPED: {redact(reason)}\n")
        write_receipt(folder, started, name, result, code, reason, argv, cwd or root, tool_rows, rows, identity)
    except OSError as error:
        sys.stderr.write(f"receipt: {name} has no receipt: {failed(error, error.filename or folder)}. The command "
                         f"{'did not run' if exited is None else f'exited {exited}'}; without a receipt this exits "
                         f"{code or SKIPPED}. Pass --receipts DIR or set CLEARCASE_RECEIPTS_DIR to a writable directory.\n")
        return code or SKIPPED
    return code


# Skills ---------------------------------------------------------------------

def load_lock():
    return json.loads(LOCK_PATH.read_text())


def skills_dir(explicit=None):
    """An explicit directory is used as given; otherwise the first default holding poteto-mode wins."""
    chosen = explicit or os.environ.get("CLEARCASE_SKILLS_DIR")
    if chosen:
        return Path(chosen).expanduser().resolve()
    defaults = [REPO / ".local/agent-tools/skills"]
    if HOME:
        defaults += [Path(HOME) / ".agents/skills", Path(HOME) / ".claude/skills"]
    return next((path.resolve() for path in defaults if (path / "poteto-mode/SKILL.md").is_file()), None)


def check_plan_script(explicit=None):
    base = skills_dir(explicit)
    return (base / "poteto-mode/scripts/check-plan.mjs") if base else Path("<skills-dir>/poteto-mode/scripts/check-plan.mjs")


# Doctor ---------------------------------------------------------------------

def bun_minimum():
    """The app's minimum Bun as (version, source, problem): packageManager in package.json when that file exists,
    otherwise MIN_BUN. problem names a package.json that cannot be read or pins no bun@MAJOR.MINOR.PATCH."""
    path = REPO / "package.json"
    if not os.path.lexists(path):
        return MIN_BUN, "MIN_BUN in scripts/agent-tools/agent_tools.py, until GRS-10 adds package.json", None
    try:
        package = json.loads(path.read_bytes())
    except OSError as error:
        return None, None, f"cannot read {failed(error, path)}"
    except ValueError as error:
        return None, None, f"package.json is not JSON: {error}"
    pinned = package.get("packageManager") if isinstance(package, dict) else None
    match = re.fullmatch(r"bun@(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.-]+)?", pinned) if isinstance(pinned, str) else None
    if not match:
        return None, None, f"package.json packageManager is {pinned!r}, not bun@MAJOR.MINOR.PATCH"
    return match[1], "packageManager in package.json", None


def system_tool(name):
    """A system tool from PATH, else from the standard system directories, where ip often lives (/usr/sbin)."""
    return shutil.which(name) or shutil.which(name, path=SYSTEM_PATH)


def chromium():
    """The Chromium the app skill drives: CLEARCASE_CHROMIUM, else the Playwright build the e2e harness uses."""
    return os.environ.get("CLEARCASE_CHROMIUM") or str(Path(HOME or "~", ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"))


def app_rows(add):
    """The app/browser prerequisites of verify app: no install, no build and no listener needed. Bun has its own row."""
    purpose = "verify-clearcase runs the app and Chromium in a network namespace of their own"
    for name, probe, package in [("unshare", "--version", "util-linux"), ("ip", "-V", "iproute2")]:
        path = system_tool(name)
        fix = f"install {package} (pacman -S {package}); {purpose}"
        if not path:
            add("FAIL", f"app-{name}", f"{name} not found on PATH or in {SYSTEM_PATH}", fix)
            continue
        version, problem = first_line([path, probe])
        if not problem and name == "unshare":
            _, _, denied = version_probe([path, "-rn", system_tool("true") or "/bin/true"])
            if denied:
                problem = f"{denied}; unprivileged user and network namespaces are unavailable"
                fix = "allow unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1)"
        add("FAIL" if problem else "PASS", f"app-{name}", problem or f"{version} at {path}" + (
            "; unshare -rn works" if name == "unshare" else ""), fix if problem else None)
    chrome = chromium()
    fix = ("set CLEARCASE_CHROMIUM to a Chromium binary, or install the Playwright build at "
           "~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome")
    if not (os.path.isfile(chrome) and os.access(chrome, os.X_OK)):
        add("FAIL", "app-chromium", f"{chrome} is not an executable file", fix)
    else:
        version, problem = first_line([chrome, "--version"])
        add("FAIL" if problem else "PASS", "app-chromium", problem or f"{version} at {chrome}", fix if problem else None)
    runner = REPO / APP_RUNNER
    ready = runner.is_file() and os.access(runner, os.X_OK)
    add("PASS" if ready else "FAIL", "app-runner", f"{APP_RUNNER} is executable" if ready else
        f"{APP_RUNNER} is missing or not executable", None if ready else
        f"restore .agents/skills/verify-clearcase from the repository (git checkout -- .agents) and chmod +x {APP_RUNNER}")


def doctor_rows(skills=None, receipts=None, identity=None, unidentified=None, tools=None):
    """The doctor's (status, name, detail, fix) rows. tools maps git, python3, node and bun to tool_info()."""
    rows = []

    def add(status, name, detail, fix=None):
        rows.append((status, name, redact(detail), fix))

    pretty, os_id = os_release()
    if sys.platform.startswith("linux"):
        add("PASS", "os", f"{pretty} ({os_id}), kernel {platform.release()}")
    else:
        add("FAIL", "os", f"{sys.platform} is unsupported", "use Linux (Arch or CachyOS); see docs/agent-tooling.md")
    bash = os.environ.get("CLEARCASE_BASH_VERSION")
    parsed = parse_version(bash)
    if parsed and parsed[:2] >= MIN_BASH:
        add("PASS", "bash", bash)
    else:
        add("FAIL", "bash", f"{bash or 'unknown'}; the bash that runs the entry points is unknown or older than 4.4",
            "run the doctor as scripts/agent-tools/doctor, which /bin/bash runs, and install bash >= 4.4 (pacman -S bash)")
    py = sys.version_info[:2]
    _, py_problem = tools["python3"]
    add("PASS" if py >= MIN_PYTHON and not py_problem else "FAIL", "python3",
        py_problem or f"{platform.python_version()} at {redact(sys.executable)}",
        None if py >= MIN_PYTHON and not py_problem else "install Python >= 3.10")

    git_row, git_problem = tools["git"]
    if git_row["path"]:
        add("FAIL" if git_problem else "PASS", "git", git_problem or f"{git_row['version']} at {git_row['path']}",
            "check the git on PATH: receipts record its --version" if git_problem else None)
        _, out, problem = git(REPO, "rev-parse", "--show-toplevel")
        top = None if problem else os.fsdecode(out.rstrip(b"\n"))
        add("PASS" if top else "FAIL", "repository", top or f"{REPO}: {problem or 'git printed no top level'}",
            None if top else "run the tools from a git checkout or worktree of the ClearCase repository")
        if top and unidentified:
            add("FAIL", "revision", unidentified)
        elif top:
            add("PASS", "revision", f"head {identity['head'][:12]}, base {identity['baseRef']} at {identity['base'][:12]}, "
                f"merge-base {identity['mergeBase'][:12]}{', uncommitted changes' if identity['dirty'] else ''}")
    else:
        add("FAIL", "git", "not found on PATH", "install git (pacman -S git) and put it on PATH")

    node_row, node_problem = tools["node"]
    if node_row["path"]:
        parsed = parse_version(node_row["version"])
        ok = bool(parsed) and parsed[:2] >= MIN_NODE
        add("PASS" if ok else "FAIL", "node", node_problem or f"{node_row['version']} at {node_row['path']}",
            None if ok else f"install Node.js >= {MIN_NODE[0]} (pacman -S nodejs)")
    else:
        add("FAIL", "node", f"not found on PATH ({redact(os.environ.get('PATH', ''))})",
            "install Node.js >= 18 (pacman -S nodejs) and put it on PATH, or set CLEARCASE_NODE=/path/to/node; "
            "pstack check-plan.mjs needs it")

    bun_row, bun_problem = tools["bun"]
    minimum, source, unpinned = bun_minimum()
    install = (f"install Bun >= {minimum} (pacman -S bun, or the installer at https://bun.sh as on puk) and put it on "
               "PATH, or set CLEARCASE_BUN=/path/to/bun; the app builds and runs with Bun from GRS-10 on")
    found = SEMVER.fullmatch(bun_row["version"] or "")
    # (major, minor, patch, released): a prerelease such as 1.4.2-canary.1 sorts before 1.4.2.
    have = (*map(int, found.groups()[:3]), not found[4]) if found else None
    if unpinned:
        add("FAIL", "bun", unpinned, f'pin "packageManager": "bun@{MIN_BUN}" in package.json, as AGENTS.md requires')
    elif not bun_row["path"]:
        override = os.environ.get("CLEARCASE_BUN")
        add("FAIL", "bun", f"CLEARCASE_BUN={override} is not an executable file" if override
            else f"not found on PATH ({redact(os.environ.get('PATH', ''))})", install)
    elif not found:  # a failed probe has no version, so bun_problem lands here too
        add("FAIL", "bun", bun_problem or f"`{bun_row['path']} --version` printed {bun_row['version']!r}, not a "
            "version MAJOR.MINOR.PATCH", f"check {bun_row['path']}, which must print its version; or {install}")
    elif have < (*map(int, minimum.split(".")), True):
        add("FAIL", "bun", f"{bun_row['version']} at {bun_row['path']} is older than {minimum}, the minimum from {source}",
            f"run bun upgrade --stable (pacman -Syu bun for the distribution package), or set CLEARCASE_BUN to a "
            f"bun >= {minimum}")
    else:
        add("PASS", "bun", f"{bun_row['version']} at {bun_row['path']}; the app needs >= {minimum} ({source})")

    for script in ["scripts/planning/check.py", "scripts/planning/generate.py"]:
        present = (REPO / script).is_file() and os.access(REPO / script, os.R_OK)
        add("PASS" if present else "FAIL", "planning", script if present else f"{script} is missing or unreadable",
            None if present else "check out the full repository with readable files")

    base = skills_dir(skills)
    try:
        lock = load_lock()
    except (OSError, ValueError) as error:
        lock = None
        add("FAIL", "skill-pin", f"cannot read {LOCK_PATH.relative_to(REPO)}: {error}",
            "restore it with git checkout -- scripts/agent-tools/skills.lock.json")
    if not base or not (base / "poteto-mode/SKILL.md").is_file():
        add("FAIL", "skills-dir", f"pstack bundle not found at {redact(base) if base else 'any default location'} (looked for poteto-mode/SKILL.md)",
            "install the pinned bundle into ~/.agents/skills (see Bootstrap in docs/agent-tooling.md) "
            "or set CLEARCASE_SKILLS_DIR / bootstrap --skills-dir DIR")
    elif lock:
        add("PASS", "skills-dir", redact(base))
        for rel in lock["requiredFiles"]:
            present = (base / rel).is_file()
            add("PASS" if present else "FAIL", "skill-file", rel,
                None if present else "reinstall the pstack bundle; this file is required by the project tools")
        drift = []
        for name, pinned in sorted(lock["skills"].items()):
            path = base / name
            if not (path / "SKILL.md").is_file():
                drift.append(name)
                add("FAIL", f"skill:{pinned['group']}", f"{name} missing",
                    f"install {name} into {redact(base)} from the pinned bundle")
                continue
            try:
                digest, count = tree_hash(path)
            except OSError as error:
                drift.append(name)
                add("FAIL", f"skill:{pinned['group']}", f"{name} cannot be hashed: {error}",
                    f"make every file of {name} readable, or reinstall it from the pinned bundle")
                continue
            if digest != pinned["sha256"]:
                drift.append(name)
                add("FAIL", f"skill:{pinned['group']}", f"{name} differs from the pin ({count} files, {digest[:12]})",
                    "review the installed change, then relock as docs/agent-tooling.md describes (bootstrap --relock "
                    "--checkout DIR for pstack, bootstrap --relock otherwise) and commit skills.lock.json")
        if not drift:
            groups = sorted({row["group"] for row in lock["skills"].values()})
            counts = ", ".join(f"{group} {sum(row['group'] == group for row in lock['skills'].values())}" for group in groups)
            add("PASS", "skill-pin", f"{len(lock['skills'])} skills match skills.lock.json ({counts})")
        pin = lock["provenance"]["pstack"]
        add("INFO", "pstack-source", f"{pin['upstream']} at {pin['revision'][:12]}, version {pin['version']}, "
            f"{pin['license']}; compare with scripts/agent-tools/verify pstack-upstream --checkout DIR")
        for name in lock.get("knownAbsent", []):
            state = "present" if (base / name / "SKILL.md").is_file() else "absent"
            add("INFO", "leaf-skill", f"{name} {state} (not installed or claimed by this project)")

    try:
        target = receipts_root(receipts)
        target.mkdir(parents=True, exist_ok=True)
        probe = target / f".doctor-probe-{os.getpid()}"
        probe.write_text("ok\n")
        probe.unlink()
        add("PASS", "receipts", f"{redact(target)} writable")
    except OSError as error:
        add("FAIL", "receipts", f"cannot write receipts: {error}",
            "set CLEARCASE_RECEIPTS_DIR to a writable ignored directory")

    for name, purpose in [("gh", "pushing and PR checks"), ("tmux", "headless worker sessions")]:
        info, _ = tool_info(name)
        add("INFO", "optional", f"{name} {info['version'] or ('version unknown' if info['path'] else 'absent')} ({purpose})")
    app_rows(add)
    return rows


def cmd_doctor(args):
    """Run every check, print the report and write it as a receipt. A missing git, head or base is a FAIL row, and so
    is a revision that cannot be read, or differs, when the doctor resolves it again after its checks."""
    started = now()
    identity, unidentified = revision(REPO, args.base)
    tools = {name: tool_info(name) for name in ("git", "python3", "node", "bun")}
    package = REPO / "package.json"
    paths = [LOCK_PATH, *([package] if os.path.lexists(package) else [])]
    inputs, unfingerprinted = fingerprints(paths)
    rows = doctor_rows(args.skills_dir, args.receipts, identity, unidentified, tools)
    if unfingerprinted:
        rows.append(("FAIL", "receipt-input", redact(unfingerprinted), "make it readable; the receipt records its sha256"))
    elif moved := inputs_changed(paths, inputs):
        rows.append(("FAIL", "receipt-input", f"changed during the run: {moved}",
                     "rerun the doctor while nothing else writes these files"))
    if not unidentified and (shifted := revision_changed(REPO, args.base, identity)):
        rows.append(("FAIL", "revision", redact(shifted),
                     "rerun the doctor while nothing else changes the checkout or its Git data"))
    lines = []
    for status, name, detail, fix in rows:
        lines.append(f"{status:<8} {name:<14} {detail}")
        if fix:
            lines.append(f"{'':<8} {'':<14} fix: {fix}")
    failures = [f"{name}: {detail}" for status, name, detail, _ in rows if status == "FAIL"]
    passed = [row for row in rows if row[0] == "PASS"]
    deferred = [row[1] for row in rows if row[0] == "DEFERRED"]
    verdict = "FAIL" if failures else "PASS"
    lines.append(f"doctor: {verdict}. {len(passed)} required checks passed, {len(failures)} failed. "
                 f"Deferred, not required yet: {', '.join(deferred) or 'none'}.")
    report = "\n".join(lines) + "\n"
    sys.stdout.write(report)
    sys.stdout.flush()
    code = 1 if failures else 0
    try:
        folder = receipt_folder(args.receipts, "doctor", started)
        (folder / "stdout.txt").write_text(report)
        (folder / "stderr.txt").write_text("")
        write_receipt(folder, started, "doctor", verdict, code, "; ".join(failures) or None,
                      [sys.executable, *sys.orig_argv[1:]], Path.cwd(), [row for row, _ in tools.values()], inputs,
                      identity)
    except OSError as error:
        sys.stderr.write(f"doctor: FAIL. Receipt not written: {error}\n")
        return 1
    return code


# Verification capabilities --------------------------------------------------

def capability_command(name, args):
    root = Path(args.root).resolve() if args.root else REPO
    python = which("python3")
    check = root / "scripts/planning/check.py"
    if name == "plan-graph":
        return [python, str(check), "--require-linear-ids"], ["python3"], [check], None
    if name == "linear-relations":
        readback = getattr(args, "readback", None)
        if not readback:
            return [python, str(check)], ["python3"], [check], (
                "no Linear readback supplied; local ID checks do not prove live graph agreement")
        readback = Path(readback).expanduser().resolve()
        return ([python, str(check), "--require-linear-ids", "--linear-relations", str(readback)], ["python3"],
                [check, readback], None)
    if name == "plan-format":
        script = check_plan_script(args.skills_dir)
        plan = Path(getattr(args, "plan", None) or root / "docs/delivery-plan.md").resolve()
        return [which("node") or "node", str(script), str(plan)], ["node"], [script, plan], None
    if name == "pstack-upstream":
        command = [python, "-I", "-B", str(TOOLS_DIR / "agent_tools.py"), "compare-upstream"]
        if not getattr(args, "checkout", None):
            return command, ["python3"], [LOCK_PATH], (
                "no pstack checkout supplied; pass --checkout DIR, a clone holding the pinned upstream revision")
        checkout = Path(args.checkout).expanduser().resolve()
        command += ["--checkout", str(checkout)]
        if args.skills_dir:
            command += ["--skills-dir", str(Path(args.skills_dir).expanduser().resolve())]
        missing = None if checkout.is_dir() else f"pstack checkout not found: {redact(checkout)}"
        return command, ["python3", "git"], [LOCK_PATH], missing
    if name == "app":
        runner = root / APP_RUNNER
        sources = sorted(runner.parent.parent.glob("lib/*.mjs")) if runner.is_file() else []
        missing = None if runner.is_file() and os.access(runner, os.X_OK) else (
            f"{redact(runner)} is missing or not executable; scripts/agent-tools/doctor names the fix")
        return [str(runner), "run"], ["bun"], [runner, *sources, root / "package.json", root / "bun.lock"], missing
    raise SystemExit(f"unknown capability {name}")


CAPABILITIES = {
    "plan-graph": "python3 scripts/planning/check.py --require-linear-ids (graph, coverage, Linear ID map, generated files)",
    "linear-relations": "python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK",
    "plan-format": "node <skills>/poteto-mode/scripts/check-plan.mjs PLAN (pstack multi-phase plan structure)",
    "pstack-upstream": "installed pstack bundle and skills.lock.json against a checkout of the pinned revision (--checkout DIR)",
    "app": "verify-clearcase run: isolated build of HEAD, offline boot under Bun, live doctor, Chromium drive, cleanup",
}


def cmd_compare_upstream(args):
    """Run by verify pstack-upstream: check the pin against the pinned revision's Git objects in a pstack clone."""
    lock, base, checkout = load_lock(), skills_dir(args.skills_dir), Path(args.checkout).resolve()
    pin = lock["provenance"]["pstack"]
    target = f"{pin['upstream']} at {pin['revision'][:12]} ({pin['version']}, {pin['license']})"
    problem = None
    if not base:
        problem = "pstack bundle not found; run scripts/agent-tools/doctor"
    elif not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", pin["revision"]):
        problem = f"provenance.pstack.revision {pin['revision']!r} is not a full commit ID"
    else:
        plugin, upstream, unread = upstream_tree(checkout, pin["revision"])
        if plugin is None:
            problem = (f"{redact(checkout)} has no .cursor-plugin/plugin.json at {pin['revision']}"
                       f"{f' ({unread})' if unread else ''}; pass a clone of {pin['upstream']} that contains the "
                       "pinned revision")
    if problem:
        print(f"FAIL     {problem}\npstack-upstream: FAIL. 1 problem against {target}.")
        return 1
    problems = []
    plugin = json.loads(plugin)
    for field in ("version", "license"):
        if plugin.get(field) != pin[field]:
            problems.append(f"plugin.json {field} is {plugin.get(field)!r}, provenance.pstack records {pin[field]!r}")
    installed = {name for name in upstream if (base / name / "SKILL.md").is_file()}
    absent = set(upstream) - installed
    pinned = {name for name, row in lock["skills"].items() if row["group"] == "pstack"}
    relock = f"review it, then run scripts/agent-tools/bootstrap --relock --checkout {redact(checkout)}"
    for name in sorted(installed - pinned):
        group = lock["skills"].get(name, {}).get("group")
        problems.append(f"{name} is an installed upstream skill but is {f'pinned as {group}' if group else 'not pinned'}; {relock}")
    for name in sorted(pinned - installed):
        problems.append(f"{name} is pinned as pstack but is {'not installed' if name in absent else 'not in the pinned revision'}")
    if sorted(absent) != sorted(pin["notInstalled"]):
        problems.append(f"upstream skills not installed are {sorted(absent)}, provenance.pstack.notInstalled "
                        f"records {sorted(pin['notInstalled'])}")
    for name in sorted(pinned & installed):
        try:
            diff = upstream_diff(upstream[name], base / name)
        except OSError as error:
            problems.append(f"{name}: installed files cannot be read: {error}")
            continue
        problems += [f"{name}/{line}" for line in diff]
        if not diff and rows_hash(upstream[name]) != lock["skills"][name]["sha256"]:
            problems.append(f"{name}: installed files match the revision but not the pinned sha256; {relock}")
    for problem in problems:
        print(f"FAIL     {problem}")
    if problems:
        print(f"pstack-upstream: FAIL. {len(problems)} problems against {target}.")
        return 1
    print(f"pstack-upstream: PASS. {len(pinned)} pinned pstack skills match {target} file for file, read from its "
          f"Git objects; {', '.join(sorted(IGNORED_PARTS))} are excluded. "
          f"Upstream skills not installed: {', '.join(sorted(absent)) or 'none'}.")
    return 0


def run_capability(name, args):
    root = Path(args.root).resolve() if args.root else REPO
    argv, tools, inputs, skip = capability_command(name, args)
    return run_with_receipt(name, argv, cwd=root, tools=tools, inputs=inputs, receipts=args.receipts,
                            base=args.base, root=root, skip_reason=skip)


def cmd_verify(args):
    if args.capability == "list":
        for name, text in CAPABILITIES.items():
            print(f"{name:<17} available {text}")
        return 0
    return run_capability(args.capability, args)


def cmd_check_plan(args):
    readback = args.linear_relations or os.environ.get("CLEARCASE_LINEAR_READBACK")
    args.readback = readback
    steps = ["plan-graph", "plan-format"]
    if readback or args.require_linear_relations:
        steps.append("linear-relations")
    results = {}
    for step in steps:
        print(f"== {step}", flush=True)
        results[step] = run_capability(step, args)
    first_failure = next((code for code in results.values() if code != 0), 0)
    summary = ", ".join(f"{step}={'PASS' if code == 0 else 'SKIPPED' if code == SKIPPED else 'FAIL'}"
                        for step, code in results.items())
    not_run = "" if "linear-relations" in results else " NOT RUN: linear-relations (pass --linear-relations PATH)."
    print(f"check-plan: {'PASS' if first_failure == 0 else 'FAIL'}. {summary}.{not_run}")
    return first_failure


def cmd_receipt(args):
    argv = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not argv:
        raise SystemExit("receipt: give the command after --")
    return run_with_receipt(args.name, argv, cwd=Path.cwd(), tools=args.tool, inputs=args.input,
                            receipts=args.receipts, base=args.base, root=Path(args.root).resolve() if args.root else REPO)


# Bootstrap ------------------------------------------------------------------

def cmd_bootstrap(args):
    try:
        return bootstrap(args)
    except OSError as error:
        raise SystemExit(f"bootstrap: FAIL. {redact(error)}") from None


def bootstrap(args):
    local = REPO / ".local/agent-tools"
    link = local / "skills"
    if args.remove:
        removed = []
        if link.is_symlink():
            link.unlink()
            removed.append(redact(link))
        state = local / "bootstrap.json"
        if state.exists():
            state.unlink()
            removed.append(redact(state))
        if local.is_dir() and not any(local.iterdir()):
            local.rmdir()
            removed.append(redact(local))
        print(f"bootstrap: removed {', '.join(removed) or 'nothing (not bootstrapped)'}. Global skills untouched.")
        return 0
    base = skills_dir(args.skills_dir)
    if (args.checkout or args.allow_drop) and not args.relock:
        raise SystemExit("bootstrap: --checkout and --allow-drop are only used with --relock")
    if args.relock:
        if not base:
            raise SystemExit("bootstrap --relock: pstack bundle not found")
        lock = load_lock()
        groups = {name: row["group"] for name, row in lock["skills"].items()}
        if args.checkout:
            checkout = Path(args.checkout).expanduser().resolve()
            _, out, unread = git(checkout, "rev-parse", "--verify", "HEAD")
            head = None if unread else out.decode(errors="replace").strip()
            plugin, upstream, unread = upstream_tree(checkout, head) if head else (None, {}, unread)
            if plugin is None:
                raise SystemExit(f"bootstrap --relock: {redact(checkout)} is not a pstack checkout (no Git HEAD with "
                                 ".cursor-plugin/plugin.json); pass the root of a clone of the pstack upstream"
                                 + (f" ({unread})" if unread else ""))
            installed = {name for name in upstream if (base / name / "SKILL.md").is_file()}
            absent = set(upstream) - installed
            if not installed:
                raise SystemExit(f"bootstrap --relock: no skill of {redact(checkout)} at {head} is installed in "
                                 f"{redact(base)}; check --skills-dir")
            changed = [f"{name}/{line}" for name in sorted(installed)
                       for line in upstream_diff(upstream[name], base / name)]
            if changed:
                raise SystemExit("bootstrap --relock: the installed bundle differs from the checkout's HEAD, so it is "
                                 "not that revision:\n  " + "\n  ".join(changed))
            dropped = sorted(name for name, group in groups.items() if group == "pstack" and name not in installed)
            if dropped and not args.allow_drop:
                raise SystemExit(f"bootstrap --relock: {', '.join(dropped)} pinned as pstack but not installed skills of "
                                 f"{redact(checkout)} at {head}. Pass --allow-drop to remove these pins.")
            added = sorted(installed - set(groups))
            moved = sorted(f"{name} (was {groups[name]})" for name in installed & set(groups) if groups[name] != "pstack")
            groups = {name: group for name, group in groups.items() if group != "pstack"} | dict.fromkeys(installed, "pstack")
        missing = [name for name in sorted(groups) if not (base / name / "SKILL.md").is_file()]
        if missing:
            raise SystemExit(f"bootstrap --relock: missing skills {', '.join(missing)}")
        lock["skills"] = {}
        for name in sorted(groups):
            digest, count = tree_hash(base / name)
            lock["skills"][name] = {"group": groups[name], "files": count, "sha256": digest}
        LOCK_PATH.write_text(json.dumps(lock, indent=2) + "\n")
        print(f"bootstrap: relocked {len(groups)} skills from {redact(base)}. Review and commit {LOCK_PATH.relative_to(REPO)}.")
        if args.checkout:
            pinned_revision = lock["provenance"]["pstack"]["revision"]
            print(f"bootstrap: {len(installed)} pinned as pstack from {redact(checkout)} at {head} "
                  f"(version {json.loads(plugin).get('version')}). Added: {', '.join(added) or 'none'}. "
                  f"Moved to pstack: {', '.join(moved) or 'none'}. Removed: {', '.join(dropped) or 'none'}. "
                  f"Upstream skills not installed: {', '.join(sorted(absent)) or 'none'}.")
            print("bootstrap: " + ("HEAD is the pinned revision; run" if head == pinned_revision else
                                   f"HEAD differs from provenance.pstack.revision {pinned_revision[:12]}; update "
                                   "provenance.pstack to match, then run")
                  + " scripts/agent-tools/verify pstack-upstream --checkout DIR.")
        return 0
    current = Path(os.readlink(link)) if link.is_symlink() else link if link.exists() else None
    if current and current != base:
        print(f"bootstrap: FAIL. {redact(link)} already points to {redact(current)}, not {redact(base)}. "
              "Run scripts/agent-tools/bootstrap --remove first if the change is intended.")
        return 1
    code = cmd_doctor(args)
    if code:
        print("bootstrap: FAIL. Fix the doctor failures above, then rerun bootstrap.")
        return code
    local.mkdir(parents=True, exist_ok=True)
    if current:
        action = "unchanged"
    else:
        link.symlink_to(base, target_is_directory=True)
        action = "linked"
    receipts_root(args.receipts).mkdir(parents=True, exist_ok=True)
    (local / "bootstrap.json").write_text(json.dumps({
        "skillsDir": redact(base), "receipts": redact(receipts_root(args.receipts)),
        "lockSha256": sha256_file(LOCK_PATH), "at": now().isoformat(),
    }, indent=2) + "\n")
    print(f"bootstrap: PASS. {redact(link)} {action} -> {redact(base)}. No global files were written.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agent-tools")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--skills-dir", help="pstack bundle directory (default: $CLEARCASE_SKILLS_DIR, bootstrap link, ~/.agents/skills)")
        p.add_argument("--receipts", help="receipt directory (default: $CLEARCASE_RECEIPTS_DIR or .local/agent-receipts)")
        p.add_argument("--base", help="base ref recorded in receipts; must resolve to a commit "
                                      "(default: $CLEARCASE_BASE_REF, then origin/dev, then dev)")
        p.add_argument("--root", help="repository root to check (default: this checkout)")
        return p

    common(sub.add_parser("doctor")).set_defaults(func=cmd_doctor)
    boot = common(sub.add_parser("bootstrap"))
    mode = boot.add_mutually_exclusive_group()
    mode.add_argument("--relock", action="store_true")
    mode.add_argument("--remove", action="store_true")
    boot.add_argument("--checkout", help="with --relock: pin every installed skill of this pstack checkout as group pstack")
    boot.add_argument("--allow-drop", action="store_true", help="with --relock --checkout: remove pstack pins it does not install")
    boot.set_defaults(func=cmd_bootstrap)
    check = common(sub.add_parser("check-plan"))
    check.add_argument("--linear-relations", metavar="READBACK")
    check.add_argument("--require-linear-relations", action="store_true")
    check.add_argument("--plan", help="plan for check-plan.mjs (default: docs/delivery-plan.md)")
    check.set_defaults(func=cmd_check_plan)
    verify = common(sub.add_parser("verify"))
    verify.add_argument("capability", choices=["list", *CAPABILITIES])
    verify.add_argument("--readback", help="Linear readback JSON for linear-relations")
    verify.add_argument("--plan", help="plan for plan-format (default: docs/delivery-plan.md)")
    verify.add_argument("--checkout", help="pstack checkout at the pinned revision for pstack-upstream")
    verify.set_defaults(func=cmd_verify)
    compare = common(sub.add_parser("compare-upstream"))
    compare.add_argument("--checkout", required=True)
    compare.set_defaults(func=cmd_compare_upstream)
    receipt = common(sub.add_parser("receipt"))
    receipt.add_argument("--name", required=True)
    receipt.add_argument("--tool", action="append", default=[], help="required tool to version-probe; missing means SKIPPED")
    receipt.add_argument("--input", action="append", default=[], help="input file to fingerprint; missing means SKIPPED")
    receipt.add_argument("command", nargs=argparse.REMAINDER)
    receipt.set_defaults(func=cmd_receipt)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
