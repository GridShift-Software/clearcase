"""ClearCase agent tooling: doctor, plan checks, verification capabilities and receipts.

Standard library only. Entry points are the bash wrappers next to this file;
see docs/agent-tooling.md for invocation, exit codes and the receipt format.
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import platform
import re
import shutil
import shlex
import stat
import subprocess
import sys
import threading
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parents[1]
LOCK_PATH = TOOLS_DIR / "skills.lock.json"
HOME = os.environ.get("HOME", "")
HOME = HOME.rstrip("/") or ("/" if HOME else "")  # /home/x/ and /home/x redact and join alike
# The HOME that redact() and seal() replace: an absolute directory other than /. A relative HOME names no home
# directory (home_dir() refuses it), and replacing it would rewrite stored words such as the outcome "recorded".
MARKED_HOME = HOME if HOME.startswith("/") and HOME != "/" else None
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
    """The display form of a path, argument or text, for output and receipts: HOME becomes ~ where a path continues it
    or ends, so /home/x2 never becomes ~2 under HOME=/home/x. It is lossy (under HOME=/inner, .../x/inner/f and a
    literal .../x~/f display alike), so a redacted value is never opened, expanded or compared. A stored value the
    tools read back has a sealed *Exact twin beside its display form, and exact() is the only way back."""
    text = str(value)
    return re.sub(re.escape(MARKED_HOME) + r"(?=[/\s:'\"]|$)", "~", text) if MARKED_HOME else text


def seal(value):
    """The lossless form of a stored path, argument or text: every HOME becomes \\h and every backslash is doubled,
    so unseal() restores the exact text, which redact() cannot. It holds no home path."""
    text = str(value)
    pieces = text.split(MARKED_HOME) if MARKED_HOME else [text]
    return "\\h".join(piece.replace("\\", "\\\\") for piece in pieces)


def unseal(text):
    def restore(match):
        if match[1] not in ("\\", "h") or match[1] == "h" and not MARKED_HOME:
            raise ValueError(f"sealed text {text!r} is malformed or names HOME, which is not an absolute directory here")
        return MARKED_HOME if match[1] == "h" else "\\"
    return re.sub(r"\\(.?)", restore, text)


def each_string(value, function):
    """function applied to each string of a JSON-like value: redact for display, seal and unseal for exact twins."""
    if isinstance(value, str):
        return function(value)
    if isinstance(value, dict):
        return {key: each_string(item, function) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [each_string(item, function) for item in value]
    return value


def redacted(value):
    """redact() through the strings of a JSON-like value, for receipts and the bootstrap state."""
    return each_string(value, redact)


def exact(row, key, record):
    """The exact value of a stored field, row[key + "Exact"] unsealed. It is the only way the tools read a stored path,
    argv or text back; row[key] is its display form. A row without the exact twin predates it and is refused."""
    if not isinstance(row, dict) or f"{key}Exact" not in row:
        raise ValueError(f"the receipt predates the exact {record} record (it has no {key}Exact); rerun the step "
                         "that wrote it to get a new receipt")
    return each_string(row[f"{key}Exact"], unseal)


def home_dir():
    """The home directory for the global skill and plugin locations. An empty or relative HOME is an error: it
    would resolve ~/.agents/skills and ~/.claude/plugins against the working directory, here the project's own."""
    if not HOME or not os.path.isabs(HOME):
        raise ValueError(f"HOME is {os.environ.get('HOME')!r}, not an absolute path; the tools locate ~/.agents/skills "
                         "and ~/.claude/plugins from it. Set HOME")
    return Path(HOME)


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
    return f"{redact(path)}: {getattr(error, "strerror", None) or error}"


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
    fields = {"repository": False, "root": redact(root), "rootExact": seal(root), "branch": None, "head": None,
              "baseRef": explicit, "base": None, "mergeBase": None, "dirty": None, "diffSha256": None}
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
    fields.update(repository=True, toplevel=redact(Path(top).resolve()), toplevelExact=seal(Path(top).resolve()), head=head,
                  branch=None if problem else out.decode(errors="backslashreplace").strip())
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
        rows.append({"path": redact(Path(path).absolute()), "realpath": redact(Path(path).resolve()),
                     "pathExact": seal(Path(path).absolute()), "realpathExact": seal(Path(path).resolve()), **found})
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
        if exact(row, "realpath", "input") != str(Path(path).resolve()):
            problems.append(f"{redact(path)}: input realpath changed")
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


def command_environment():
    # Prevent interpreter startup hooks and Git redirection; hash all other environment values.
    removed = {"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"}
    return {key: value for key, value in os.environ.items()
            if key not in removed and not key.startswith(("GIT_", "PYTHON"))}


def executing_path(name, cwd):
    if "/" in name:
        path = Path(name)
        return (path if path.is_absolute() else Path(cwd) / path).resolve()
    selected = shutil.which(name, path=command_environment().get("PATH", os.defpath))
    return Path(selected).resolve() if selected else None


def binary_identity(name, cwd):
    path = executing_path(name, cwd)
    return {"path": redact(path), "pathExact": seal(path), **file_identity(path)} if path else None


def execution_identity(argv, cwd):
    env = command_environment()
    snapshot = {key: hashlib.sha256(value.encode()).hexdigest() for key, value in sorted(env.items())
                if key not in ("_", "SHLVL", "PWD", "OLDPWD")}
    # Keep PATH/TMPDIR inspectable; other values (including every CLEARCASE_* value) stay secret.
    # argv and cwd are display; argvExact and cwdExact are what validate_execution recomputes from (see exact).
    return {"argv": [redact(part) for part in argv], "commandLine": redact(shlex.join(argv)),
            "argvExact": [seal(part) for part in argv], "cwdExact": seal(Path(cwd).resolve()),
            "argvSha256": hashlib.sha256(json.dumps(argv).encode()).hexdigest(), "cwd": redact(Path(cwd).resolve()),
            "executable": binary_identity(argv[0], cwd) if argv else None,
            "runtimes": {name: binary_identity(name, cwd) for name in ("bun", "python3", "bash")},
            "environment": {"PATH": redact(env.get("PATH", "")), "TMPDIR": redact(env.get("TMPDIR", "")),
                            "valuesSha256": snapshot}}


def exact_input_paths(rows):
    """The paths of receipt input rows, from their exact records; inputs_changed() requires realpathExact too."""
    return [Path(exact(row, "path", "input")) for row in rows]


def check_inputs(check):
    rows = check.get("inputs")
    if not isinstance(rows, list):
        raise ValueError("check lacks input fingerprints")
    paths = exact_input_paths(rows)
    changed = inputs_changed(paths, rows)
    if changed:
        raise ValueError(f"check inputs changed: {changed}")
    return paths


def validate_execution(check, requirement):
    expected = requirement.get("execution")
    if not isinstance(expected, dict) or not expected.get("executable"):
        raise ValueError("required check must bind execution identity; a name alone is insufficient")
    recorded = check.get("execution")
    if recorded != expected or check.get("command") != expected.get("argv"):
        raise ValueError("required check command/argv/executable/environment mismatch")
    current = execution_identity(exact(recorded, "argv", "execution"), Path(exact(recorded, "cwd", "execution")))
    if current != recorded:
        raise ValueError("check execution identity changed at approval (runtime, PATH or environment)")
    if requirement.get("inputs") != check.get("inputs"):
        raise ValueError("required check input identities mismatch")
    return check_inputs(check)


def run_captured(argv, cwd, folder):
    """Run argv, streaming its output live and capturing it in folder, as (exit code, problem). The code is None when
    argv did not start; otherwise problem names output that was not captured whole, or a capture file that lost or
    changed it."""
    code, problems = None, []
    try:
        with open(folder / "stdout.txt", "w+b") as out_file, open(folder / "stderr.txt", "w+b") as err_file:
            child = subprocess.Popen([str(executing_path(argv[0], cwd) or argv[0]), *argv[1:]], cwd=cwd, env=command_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
            problems.append(failed(error, argv[0] if error.filename == str(executing_path(argv[0], cwd)) else error.filename or folder))
    return code, "; ".join(problems) or None


def write_receipt(folder, started, name, result, code, reason, argv, cwd, tool_rows, inputs, identity,
                  *, metadata=None, spend=None):
    finished = now()
    artifacts = {"receipt": str(folder / "receipt.json"), "stdout": str(folder / "stdout.txt"),
                 "stderr": str(folder / "stderr.txt")}
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
        "artifacts": redacted(artifacts),
        "artifactsExact": each_string(artifacts, seal),
    }
    receipt.update(redacted(metadata or {}))
    if "approval" in receipt and result != "PASS":
        receipt["approval"]["state"] = "refuse"
    if "dispatch" in receipt and result != "PASS" and receipt["dispatch"]["outcome"] != "cancellation-failed":
        receipt["dispatch"]["outcome"] = "refuse"
    receipt["spend"] = spend or {"actualUsd": None, "actualSource": None, "targetUsd": None,
                                 "capUsd": None, "capEnforced": False}
    if "dispatch" in receipt:
        event = append_event(folder.parent, "dispatch", {"receipt": str(folder / "receipt.json"), "row": receipt["dispatch"]})
        receipt["dispatchEvent"] = event["hash"]
    if name == "approve" and result == "PASS":
        # The ledger row is this event; approval-check refuses a receipt that differs from it or is missing from the log.
        event = append_event(folder.parent, "approval", {"receipt": str(folder / "receipt.json"),
                                                         "row": receipt["approval"], "inputs": receipt["inputs"]})
        receipt["approvalEvent"] = event["hash"]
    (folder / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    cost = receipt["spend"]
    actual = "unavailable" if cost["actualUsd"] is None else f"USD {cost['actualUsd']:g} ({cost['actualSource']})"
    target = "unavailable" if cost["targetUsd"] is None else f"USD {cost['targetUsd']:g} (reporting only)"
    sys.stderr.write(f"spend: actual={actual}; target={target}; cap=unavailable (no enforcement; no T3 cap)\n")
    sys.stderr.write(f"receipt: {result} {name} exit={code} {redact(folder / 'receipt.json')}\n")
    sys.stderr.flush()


def run_with_receipt(name, argv, *, cwd=None, tools=(), inputs=(), receipts=None, base=None, root=None,
                     skip_reason=None, required=False, metadata=None, spend=None, expected_head=None):
    """Collect the evidence first: the revision, each tool's path and version and each input's identity. Run argv
    only if all of it was collected, stream and capture its output, look at the captures, inputs and revision again
    and write a receipt. Evidence that cannot be collected, or changes during the run, is never PASS. Returns the exit
    code."""
    root = Path(root or REPO)
    started = now()
    try:
        folder = receipt_folder(receipts, name, started)
    except OSError as error:
        sys.stderr.write(f"{'FAIL' if required else 'SKIPPED'} {name}: cannot create its receipt directory: "
                         f"{failed(error, error.filename or receipts_root(receipts))}; pass --receipts DIR or set "
                         "CLEARCASE_RECEIPTS_DIR to a writable directory. The command did not run.\n")
        return 1 if required else SKIPPED
    probed = [tool_info(tool) for tool in dict.fromkeys(["git", *tools])]
    tool_rows = [row for row, _ in probed]
    unprobed = [problem for _, problem in probed if problem]
    missing = [row["name"] for row in tool_rows if row["path"] is None]
    if argv and not missing and not skip_reason and not (shutil.which(argv[0]) or Path(argv[0]).is_file()):
        missing.append(argv[0])
    identity, unidentified = revision(root, base)
    if str(TOOLS_DIR / "test_guard.mjs") in argv and not unidentified:
        argv = list(argv)
        fix_ref = argv[argv.index("--fix-base") + 1]
        fix_base, guard_problem = commit_of(root, fix_ref)
        if guard_problem or not fix_base:
            unidentified = guard_problem or "guard fix base is not a commit"
        else:
            position = argv.index("--") if "--" in argv else len(argv)
            argv[position:position] = ["--expected-root", str(root.resolve()), "--expected-head", identity["head"],
                                       "--expected-base", fix_base]
    if expected_head and not unidentified and (identity["head"] != expected_head or identity["dirty"]):
        unidentified = "the escalation source no longer names the exact clean HEAD SHA"
    here = Path(cwd or root).resolve()
    if not unidentified and here != root.resolve():
        _, out, problem = git(here, "rev-parse", "--show-toplevel")
        if problem or Path(os.fsdecode(out.rstrip(b"\n"))).resolve() != root.resolve():
            unidentified = (f"the command would run in {redact(here)}, outside the checkout {redact(root.resolve())} "
                            "whose revision the receipt records; run it inside that checkout, or pass --root DIR "
                            "naming the checkout it runs in")
    inputs = list(dict.fromkeys([*inputs, *[Path(here) / word for word in argv
                  if not word.startswith("-") and (Path(here) / word).is_file()]]))
    rows, unfingerprinted = fingerprints(inputs)
    execution, execution_problem = None, None
    try:
        execution = execution_identity(argv, here)
    except OSError as error:
        execution_problem = f"execution identity unreadable: {error}"
    metadata = {**(metadata or {}), "execution": execution}
    reason = (skip_reason
              or (missing and f"required tool not found: {', '.join(missing)}; install it or put it on PATH "
                              "(scripts/agent-tools/doctor names the fix)")
              or (unprobed and f"tool version unknown: {'; '.join(unprobed)}")
              or unidentified
              or execution_problem
              or unfingerprinted
              or None)
    exited, result, code = None, "SKIPPED", SKIPPED
    if not reason:
        exited, problem = run_captured(argv, cwd or root, folder)
        moved = None if exited is None else inputs_changed(inputs, rows)
        shifted = None if exited is None else revision_changed(root, base, identity)
        if exited is not None:
            try:
                if execution_identity(argv, here) != execution:
                    shifted = "execution identity changed during the run"
            except OSError as error:
                shifted = f"execution identity unreadable after run: {error}"
        if exited is None:
            reason = f"the command did not start: {problem}"
        elif problem:
            reason = f"output not captured whole: {problem}; the command exited {exited}"
            result, code = ("FAIL", exited or 1)
        elif moved or shifted:
            reason = "; ".join(filter(None, [moved and f"input changed during the run: {moved}", shifted,
                                             f"the command exited {exited}"]))
            result, code = ("FAIL", exited or 1)
        else:
            result, code = "PASS" if exited == 0 else "FAIL", exited
    if required and result == "SKIPPED":
        result, code = "FAIL", 1
    if reason:
        sys.stderr.write(f"{result} {name}: {redact(reason)}\n")
    try:
        if exited is None:
            (folder / "stdout.txt").write_bytes(b"")
            (folder / "stderr.txt").write_text(f"{result}: {redact(reason)}\n")
        write_receipt(folder, started, name, result, code, reason, argv, cwd or root, tool_rows, rows, identity,
                      metadata=metadata, spend=spend)
    except (OSError, ValueError) as error:
        sys.stderr.write(f"receipt: {name} has no receipt: {failed(error, getattr(error, "filename", None) or folder)}. The command "
                         f"{'did not run' if exited is None else f'exited {exited}'}; without a receipt this exits "
                         f"{code or SKIPPED}. Pass --receipts DIR or set CLEARCASE_RECEIPTS_DIR to a writable directory.\n")
        return code or (1 if required else SKIPPED)
    return code


# Skills ---------------------------------------------------------------------

def load_lock():
    return json.loads(LOCK_PATH.read_text())


REQUIRED_PSTACK_FILES = (
    "poteto-mode/SKILL.md", "poteto-mode/playbooks/orchestrate.md",
    "poteto-mode/playbooks/multi-phase-plan.md", "poteto-mode/scripts/check-plan.mjs",
    "create-verification-skill/SKILL.md", "maintain-verification-skill/SKILL.md",
    "setup-pstack/SKILL.md", "swarm/SKILL.md",
)


def skills_dir(explicit=None):
    """Independent leaf skills, also the legacy pstack fallback when no plugin is installed. A raw path; ValueError
    when nothing names it and HOME cannot."""
    chosen = explicit or os.environ.get("CLEARCASE_SKILLS_DIR")
    return (Path(chosen).expanduser() if chosen else home_dir() / ".agents/skills").resolve()


def plugin_version(value):
    """SemVer precedence, including numeric prerelease identifiers (rc.10 sorts after rc.9)."""
    match = SEMVER.fullmatch(value)
    if not match:
        raise ValueError(f"invalid plugin version {value!r}")
    prerelease = match[4]
    parts = tuple((0, int(part)) if part.isdigit() else (1, part)
                  for part in prerelease[1:].split(".")) if prerelease else ()
    return (*map(int, match.groups()[:3]), not prerelease, parts)


HARNESS_VARIABLES = {"claude": "CLAUDECODE", "codex": "CODEX_THREAD_ID"}


def pstack_registered(registry):
    """Whether installed_plugins.json has a t3-pstack record. A missing registry proves the plugin is absent; one that
    cannot be read or understood proves nothing, so it is an error."""
    try:
        text = registry.read_text()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise ValueError(f"cannot read the plugin registry {failed(error, registry)}; "
                         "that leaves t3-pstack absence unproven") from None
    try:
        records = json.loads(text)["plugins"].get("t3-pstack@t3-pstack", [])
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ValueError(f"{registry} is not a plugin registry (JSON with a plugins object); "
                         "that leaves t3-pstack absence unproven") from None
    if not isinstance(records, list):
        raise ValueError(f"{registry} lists t3-pstack@t3-pstack as {type(records).__name__}, not a list of installs")
    return bool(records)


def codex_config(path):
    """Codex's config.toml as a dict, {} when absent. Never printed: it can hold credentials for other tools."""
    try:
        import tomllib
    except ImportError:
        raise ValueError("reading Codex's config.toml needs Python >= 3.11 (tomllib)") from None
    try:
        config = tomllib.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ValueError(f"cannot read {failed(error, path)}; that leaves the Codex t3-pstack install unproven") from None
    except tomllib.TOMLDecodeError:
        raise ValueError(f"{redact(path)} is not valid TOML; that leaves the Codex t3-pstack install unproven") from None
    for table in ("plugins", "marketplaces"):
        if not isinstance(config.get(table, {}), dict):
            raise ValueError(f"{redact(path)} has a {table} key that is not a table")
    return config


def json_record(path):
    """A JSON object from an install record; ValueError naming the file when it is missing, unreadable or malformed."""
    try:
        value = json.loads(path.read_text())
    except OSError as error:
        raise ValueError(f"cannot read {failed(error, path)}") from None
    except ValueError:
        raise ValueError(f"{redact(path)} is not JSON") from None
    if not isinstance(value, dict):
        raise ValueError(f"{redact(path)} must hold a JSON object")
    return value


def harness_layout(harness, home):
    """Where a harness keeps its t3-pstack cache and the records that prove an install of it."""
    if harness == "claude":
        plugins = home / ".claude/plugins"
        return {"cache": plugins / "cache/t3-pstack/t3-pstack", "registry": plugins / "installed_plugins.json"}
    chosen = os.environ.get("CODEX_HOME")
    if chosen is not None and not os.path.isabs(chosen):
        raise ValueError(f"CODEX_HOME is {chosen!r}, not an absolute path; Codex's config and plugin cache are located from it")
    base = Path(chosen) if chosen else home / ".codex"
    clone = base / ".tmp/marketplaces/t3-pstack"
    return {"cache": base / "plugins/cache/t3-pstack/t3-pstack", "config": base / "config.toml",
            "install": clone / ".codex-marketplace-install.json", "listing": clone / ".claude-plugin/marketplace.json"}


def cached_versions(cache):
    return [path for path in cache.iterdir() if path.is_dir()] if cache.exists() else []


def harness_present(harness, layout):
    """Whether the harness has t3-pstack: a cache version, or a record naming it. An unreadable record proves nothing."""
    if cached_versions(layout["cache"]):
        return True
    if harness == "claude":
        return pstack_registered(layout["registry"])
    return "t3-pstack@t3-pstack" in codex_config(layout["config"]).get("plugins", {})


def harness_choice():
    """(harness, why) from T3_PSTACK_HARNESS, else from the running session's own variable; (None, None) outside both."""
    if "T3_PSTACK_HARNESS" in os.environ:
        chosen = os.environ["T3_PSTACK_HARNESS"]
        if chosen not in HARNESS_VARIABLES:
            raise ValueError(f"T3_PSTACK_HARNESS is {chosen!r}; set it to claude or codex, or unset it")
        return chosen, "T3_PSTACK_HARNESS"
    active = [name for name, variable in HARNESS_VARIABLES.items() if os.environ.get(variable)]
    if len(active) > 1:
        raise ValueError("CLAUDECODE and CODEX_THREAD_ID are both set, so the active harness is ambiguous; "
                         "set T3_PSTACK_HARNESS to claude or codex")
    return (active[0], f"active harness ({HARNESS_VARIABLES[active[0]]})") if active else (None, None)


def manifest_version(path):
    manifest = json.loads(path.read_text())
    if manifest.get("name") != "t3-pstack":
        raise ValueError(f"{path} names {manifest.get('name')!r}, expected t3-pstack")
    version = manifest.get("version")
    if not isinstance(version, str) or plugin_version(version) < plugin_version("2.0.0-rc.5") or plugin_version(version)[0] != 2:
        raise ValueError(f"unsupported t3-pstack version {version!r}; expected >= 2.0.0-rc.5 and < 3.0.0")
    return version


def claude_install(layout, root, explicit):
    """(version, SHA) of a Claude install: its manifest and exactly one installed_plugins.json record for this root."""
    version = manifest_version(root / ".claude-plugin/plugin.json")
    if not explicit and root.name != version:
        raise ValueError(f"plugin directory version {root.name!r} differs from manifest version {version!r}")
    registry = layout["registry"]
    records = json.loads(registry.read_text()).get("plugins", {}).get("t3-pstack@t3-pstack", [])
    records = [row for row in records if Path(row["installPath"]).expanduser().resolve() == root]
    if len(records) != 1:
        raise ValueError(f"{registry} must contain exactly one t3-pstack install record for {root}")
    if records[0].get("version") != version:
        raise ValueError(f"installed_plugins.json version {records[0].get('version')!r} differs from manifest version {version!r}")
    sha = records[0].get("gitCommitSha")
    if not isinstance(sha, str) or not FULL_ID.fullmatch(sha):
        raise ValueError("installed_plugins.json gitCommitSha must be an exact Git SHA")
    return version, sha


def codex_install(layout, root, explicit):
    """(version, revision) of a Codex install. config.toml enables t3-pstack@t3-pstack from the t3-pstack marketplace;
    the marketplace clone records an exact revision from that same source and lists one t3-pstack version; root is that
    version's cache directory and its manifest agrees. Codex has no per-plugin SHA: the revision is the marketplace's."""
    config = codex_config(layout["config"])
    plugin = config.get("plugins", {}).get("t3-pstack@t3-pstack")
    if not isinstance(plugin, dict) or plugin.get("enabled") is not True:
        raise ValueError(f"t3-pstack@t3-pstack is not enabled in {redact(layout['config'])}; enable it through T3 or Codex")
    source = (config.get("marketplaces", {}).get("t3-pstack") or {}).get("source")
    record = json_record(layout["install"])
    if not isinstance(source, str) or record.get("source") != source:
        raise ValueError(f"{redact(layout['install'])} records another source than the t3-pstack marketplace in config.toml "
                         "(neither is printed: a source URL can carry credentials)")
    revision = record.get("revision")
    if not isinstance(revision, str) or not FULL_ID.fullmatch(revision):
        raise ValueError(f"{redact(layout['install'])} revision must be an exact Git SHA")
    listed = [row for row in json_record(layout["listing"]).get("plugins", [])
              if isinstance(row, dict) and row.get("name") == "t3-pstack"]
    if len(listed) != 1 or not isinstance(listed[0].get("version"), str):
        raise ValueError(f"{redact(layout['listing'])} must list t3-pstack once, with its version")
    recorded = listed[0]["version"]
    if root != (layout["cache"] / recorded).resolve():
        held = f"{redact(root)} is not" if explicit else f"the newest Codex cache version {root.name!r} is not"
        raise ValueError(f"{held} the version the marketplace records, {recorded!r}; the install is stale, orphaned or "
                         "unfinished. Let Codex finish updating t3-pstack through T3")
    version = manifest_version(root / ".codex-plugin/plugin.json")
    if version != recorded:
        raise ValueError(f".codex-plugin/plugin.json version {version!r} differs from the marketplace's {recorded!r}")
    return version, revision


def pstack_source(explicit=None):
    """Return the selected source (raw paths; redact only to display it), its fingerprint inputs, and a failure.

    The harness is T3_PSTACK_HARNESS, else the one T3_PSTACK_ROOT lies in, else the running session's (CLAUDECODE or
    CODEX_THREAD_ID), else Claude when it has t3-pstack, else Codex. Its install is judged only by its own records. A
    broken, stale or missing install of the chosen harness fails; it never falls back to the other harness, an older
    version or legacy skills. Legacy skills are used only when no harness was named and neither has t3-pstack."""
    source = {"kind": "plugin", "harness": None, "harnessSelection": None, "root": None, "skillsDir": None,
              "version": None, "gitCommitSha": None}
    paths = []
    try:
        home = home_dir()
        harness, why = harness_choice()
        if "T3_PSTACK_ROOT" in os.environ:
            chosen = os.environ["T3_PSTACK_ROOT"]
            if not chosen.strip():
                raise ValueError("T3_PSTACK_ROOT is empty; give the installed plugin root")
            root = Path(chosen).expanduser().resolve()
            source["selection"] = "T3_PSTACK_ROOT"
            if why != "T3_PSTACK_HARNESS":
                in_codex = root.parent == harness_layout("codex", home)["cache"].resolve()
                harness, why = ("codex", "T3_PSTACK_ROOT in the Codex cache") if in_codex else (
                    "claude", "T3_PSTACK_ROOT outside the Codex cache")
            layout = harness_layout(harness, home)
        else:
            if harness is None:
                why = "default (no active harness; Claude, then Codex)"
                harness = next((name for name in HARNESS_VARIABLES if harness_present(name, harness_layout(name, home))), None)
            elif not harness_present(harness, harness_layout(harness, home)):
                other = next(name for name in HARNESS_VARIABLES if name != harness)
                if why == "T3_PSTACK_HARNESS" or harness_present(other, harness_layout(other, home)):
                    raise ValueError(f"{why} selects {harness}, which has no t3-pstack install; another harness's install "
                                     f"is never validated in its place, nor are legacy skills. Install t3-pstack for "
                                     f"{harness} through T3, or set T3_PSTACK_HARNESS to the harness you run")
                harness = None
            if harness is None:
                registry = harness_layout("claude", home)["registry"]
                base = skills_dir(explicit)
                source.update(kind="legacy", root=str(base), skillsDir=str(base), selection="legacy fallback")
                paths = [*([registry] if registry.exists() else []), *[base / rel for rel in REQUIRED_PSTACK_FILES]]
                if not (base / "poteto-mode/SKILL.md").is_file():
                    raise ValueError("canonical t3-pstack plugin and legacy pstack bundle not found; "
                                     "install t3-pstack through T3 or set T3_PSTACK_ROOT to a registered install")
                missing = [str(path) for path in paths if not path.is_file() or not os.access(path, os.R_OK)]
                if missing:
                    raise ValueError(f"required legacy pstack file missing or unreadable: {', '.join(missing)}")
                return source, paths, None
            layout = harness_layout(harness, home)
            versions = cached_versions(layout["cache"])
            if not versions:
                record = "installed_plugins.json" if harness == "claude" else "config.toml"
                raise ValueError(f"t3-pstack is registered in {record} but {layout['cache']} holds no installed "
                                 "version; repair or reinstall the plugin through T3. Legacy skills never stand in "
                                 "for a registered plugin")
            root = max(versions, key=lambda path: plugin_version(path.name)).resolve()
            source["selection"] = f"newest {harness.capitalize()} plugin cache version"
        source.update(harness=harness, harnessSelection=why, root=str(root), skillsDir=str(root / "skills"))
        records = ([layout["registry"], root / ".claude-plugin/plugin.json"] if harness == "claude" else
                   [layout["config"], layout["install"], layout["listing"], root / ".codex-plugin/plugin.json"])
        paths = [*records, *[root / "skills" / rel for rel in REQUIRED_PSTACK_FILES]]
        install = claude_install if harness == "claude" else codex_install
        source["version"], source["gitCommitSha"] = install(layout, root, source["selection"] == "T3_PSTACK_ROOT")
        missing = [str(path) for path in paths if not path.is_file() or not os.access(path, os.R_OK)]
        if missing:
            raise ValueError(f"required pstack file missing or unreadable: {', '.join(missing)}")
        return source, paths, None
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        return source, paths, f"pstack discovery failed: {error}"


def pstack_harness(source):
    if not source["harness"]:
        return "no harness (legacy)"
    return f"harness {source['harness']}, chosen by {source['harnessSelection']}"


def pstack_summary(source):
    """The one-line identity the pstack capability prints, from the discovery its receipt records."""
    return (f"pstack: PASS. {source['selection']} at {redact(source['root'])}; {pstack_harness(source)}; "
            f"version {source['version'] or 'unavailable (legacy)'}; SHA {source['gitCommitSha'] or 'unavailable (legacy)'}. "
            "Upstream bundle comparison is retired.")


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
    """The Chromium the app skill drives: CLEARCASE_CHROMIUM, else the build scripts/ci/install-chrome.sh installs."""
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
    fix = ("run scripts/ci/install-chrome.sh, which installs CI's checksum-pinned Chrome for Testing at "
           "~/.cache/ms-playwright/chromium-1223, or set CLEARCASE_CHROMIUM to a Chromium binary")
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


def doctor_rows(skills=None, receipts=None, identity=None, unidentified=None, tools=None, pstack=None):
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

    try:
        base = skills_dir(skills)
    except ValueError as error:
        base = None
        add("FAIL", "skills-dir", str(error), "set HOME, or pass --skills-dir DIR / set CLEARCASE_SKILLS_DIR")
    try:
        lock = load_lock()
    except (OSError, ValueError) as error:
        lock = None
        add("FAIL", "skill-pin", f"cannot read {LOCK_PATH.relative_to(REPO)}: {error}",
            "restore it with git checkout -- scripts/agent-tools/skills.lock.json")
    source, _, problem = pstack
    add("FAIL" if problem else "PASS", "pstack-source", problem or
        f"{source['selection']}: {source['root']}; {pstack_harness(source)}; "
        f"version {source['version'] or 'unavailable (legacy)'}; SHA {source['gitCommitSha'] or 'unavailable (legacy)'}",
        "check T3_PSTACK_ROOT, T3_PSTACK_HARNESS and the chosen harness's install records (installed_plugins.json for "
        "Claude; config.toml and the marketplace install record for Codex); do not reinstall upstream pstack"
        if problem else None)
    if not problem:
        plugin_skills = Path(source["skillsDir"])
        for rel in REQUIRED_PSTACK_FILES:
            present = (plugin_skills / rel).is_file() and os.access(plugin_skills / rel, os.R_OK)
            add("PASS" if present else "FAIL", "skill-file", rel,
                None if present else "restore the required file in the selected pstack installation")
    if lock and base:
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
                    "for independent leaf skills) and commit skills.lock.json")
        if not drift:
            groups = sorted({row["group"] for row in lock["skills"].values()})
            counts = ", ".join(f"{group} {sum(row['group'] == group for row in lock['skills'].values())}" for group in groups)
            add("PASS", "skill-pin", f"{len(lock['skills'])} skills match skills.lock.json ({counts})")
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
    pstack = pstack_source(args.skills_dir)
    paths = [LOCK_PATH, *([package] if os.path.lexists(package) else []), *pstack[1]]
    inputs, unfingerprinted = fingerprints(paths)
    rows = doctor_rows(args.skills_dir, args.receipts, identity, unidentified, tools, pstack)
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
                      identity, metadata={"pstack": pstack[0]}, spend=spend_fields(args))
    except OSError as error:
        sys.stderr.write(f"doctor: FAIL. Receipt not written: {error}\n")
        return 1
    return code


# Verification capabilities --------------------------------------------------

RETIRED = {"pstack-upstream": "pstack-upstream is retired: it compares nothing against upstream, and a passing result "
                              "under its name would claim that; use scripts/agent-tools/verify pstack for the "
                              "installed-plugin identity check (--checkout is not used)."}


def capability_command(name, args):
    """(argv, tools, inputs, skip reason, pstack source or None). The source is the one whose paths are fingerprinted."""
    root = Path(args.root).resolve() if args.root else REPO
    python = which("python3")
    check = root / "scripts/planning/check.py"
    if name == "plan-graph":
        return [python, str(check), "--require-linear-ids"], ["python3"], [check], None, None
    if name == "linear-relations":
        readback = getattr(args, "readback", None)
        if not readback:
            return [python, str(check)], ["python3"], [check], (
                "no Linear readback supplied; local ID checks do not prove live graph agreement"), None
        readback = Path(readback).expanduser().resolve()
        return ([python, str(check), "--require-linear-ids", "--linear-relations", str(readback)], ["python3"],
                [check, readback], None, None)
    if name == "plan-format":
        script = root / "scripts/planning/plan_format.py"
        plan = Path(getattr(args, "plan", None) or root / "docs/delivery-plan.md").resolve()
        inputs = [root / "docs/plan" / rel for rel in ("work-items.json", "view-coverage.json", "program-intro.md")]
        return [python, str(script), "--root", str(root), str(plan)], ["python3"], [script, plan, *inputs], None, None
    if name in RETIRED:
        return [], [], [], RETIRED[name], None
    if name in ("pstack-plan-format", "pstack"):
        source, paths, problem = pstack_source(args.skills_dir)
        if name == "pstack-plan-format":
            script = Path(source["skillsDir"] or "<pstack>/skills") / "poteto-mode/scripts/check-plan.mjs"
            plan = Path(args.plan).resolve() if getattr(args, "plan", None) else None
            if plan is None:
                problem = problem or ("pstack-plan-format checks a plan written in pstack's multi-phase format; give it "
                                      "with --plan PATH (docs/delivery-plan.md is checked by plan-format)")
            return ([which("node") or "node", str(script), str(plan or "")], ["node"],
                    [LOCK_PATH, *paths, *([plan] if plan else [])], problem, source)
        # The identity was discovered once, above; print that, so the receipt and its fingerprints cannot disagree.
        return [python, "-I", "-B", "-c", "import sys; print(sys.argv[1])", "" if problem else pstack_summary(source)], \
            ["python3"], [LOCK_PATH, *paths], problem, source
    if name == "models":
        source, paths, problem = pstack_source(args.skills_dir)
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home_dir() / ".config")
        sheet = Path(args.model_sheet).expanduser().resolve() if args.model_sheet else config / "t3-pstack/models.md"
        catalog = Path(args.catalog).expanduser().resolve() if args.catalog else None
        plugin = Path(source["root"] or "<plugin>")
        validator = Path(source["skillsDir"] or "<skills>") / "setup-pstack/scripts/t3-sheet.mjs"
        models = plugin / "models.json"
        wrapper = TOOLS_DIR / "model_sheet.mjs"
        if not sheet.is_file():
            problem = f"model sheet missing: {sheet}; supply --model-sheet PATH (no settings are written)"
        elif catalog is None:
            problem = "fresh model catalogue missing: supply --catalog PATH from orchestrator_capabilities"
        elif not validator.is_file() or not models.is_file():
            problem = "canonical model-sheet validator/models.json missing from selected plugin"
        return ([which("node") or "node", str(wrapper), str(sheet), str(catalog or ""), str(validator), str(models)],
                ["node"], [*paths, wrapper, sheet, validator, models, *([catalog] if catalog else [])], problem, source)
    if name == "test-guard":
        script = TOOLS_DIR / "test_guard.mjs"
        findings = Path(args.findings).expanduser().resolve() if args.findings else None
        problem = None if findings and args.fix_base else "test-guard requires --findings PATH and --fix-base REF"
        return ([which("node") or "node", str(script), "--root", str(root), "--fix-base", args.fix_base or "",
                 "--findings", str(findings or "")], ["node"], [script, *([findings] if findings else [])], problem, None)
    if name == "app":
        runner = root / APP_RUNNER
        sources = sorted(runner.parent.parent.glob("lib/*.mjs")) if runner.is_file() else []
        missing = None if runner.is_file() and os.access(runner, os.X_OK) else (
            f"{redact(runner)} is missing or not executable; scripts/agent-tools/doctor names the fix")
        return [str(runner), "run"], ["bun"], [runner, *sources, root / "package.json", root / "bun.lock"], missing, None
    raise SystemExit(f"unknown capability {name}")


CAPABILITIES = {
    "models": "canonical model sheet/catalogue validation plus ClearCase max/ultracode prohibition",
    "test-guard": "protect findings-named JS/TS tests and touched-file assertion counts across a fix diff",
    "plan-graph": "python3 scripts/planning/check.py --require-linear-ids (graph, coverage, Linear ID map, generated files)",
    "linear-relations": "python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK",
    "plan-format": "python3 scripts/planning/plan_format.py PLAN (the generated ClearCase delivery-plan contract)",
    "pstack-plan-format": "node <skills>/poteto-mode/scripts/check-plan.mjs --plan PATH (pstack's generic format; not in check-plan)",
    "pstack": "canonical t3-pstack install identity and required files (legacy fallback only when absent)",
    "pstack-upstream": "retired; FAILs with a migration message to verify pstack (no upstream comparison is made)",
    "app": "verify-clearcase run: isolated build of HEAD, offline boot under Bun, live doctor, Chromium drive, cleanup",
}


def cmd_compare_upstream(args):
    """Callable so old scripts get a clear failure, never a PASS under the retired comparison's name."""
    sys.stderr.write(f"compare-upstream: FAIL. {RETIRED['pstack-upstream']}\n")
    return 1


def guard_claims(root, args):
    """What a test-guard receipt binds for approval: the commit the diff is measured from and the manifest's own claims
    about the review that prompted the fix round. approve compares them with the ledger's recorded review."""
    base = commit_of(root, args.fix_base)[0] if args.fix_base else None
    claims = dict.fromkeys(("manifestSha256", "reviewFindingsSha256", "unit", "tests", "testsExact"))
    try:
        findings = Path(args.findings).expanduser().resolve()
        manifest = json_object(findings)
        claims.update(manifestSha256=sha256_file(findings), reviewFindingsSha256=manifest.get("reviewFindingsSha256"),
                      unit=manifest.get("unit"), tests=manifest.get("tests"),
                      testsExact=each_string(manifest.get("tests"), seal))
    except (OSError, ValueError, TypeError):
        pass  # the guard itself refuses a missing or malformed manifest
    return {"guard": {"fixBase": base, **claims}}


def run_capability(name, args):
    root = Path(args.root).resolve() if args.root else REPO
    argv, tools, inputs, skip, pstack = capability_command(name, args)
    metadata = {"pstack": pstack} if pstack else guard_claims(root, args) if name == "test-guard" else None
    return run_with_receipt(name, argv, cwd=root, tools=tools, inputs=inputs, receipts=args.receipts,
                            base=args.base, root=root, skip_reason=skip,
                            required=name in ("plan-format", "pstack-plan-format", "pstack", "models", "test-guard", *RETIRED),
                            metadata=metadata, spend=spend_fields(args))


def cmd_verify(args):
    if args.capability == "list":
        for name, text in CAPABILITIES.items():
            print(f"{name:<17} {'retired  ' if name in RETIRED else 'available'} {text}")
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
    summary = ", ".join(f"{step}={'PASS' if code == 0 else 'SKIPPED' if code == SKIPPED and step != 'plan-format' else 'FAIL'}"
                        for step, code in results.items())
    not_run = "" if "linear-relations" in results else " NOT RUN: linear-relations (pass --linear-relations PATH)."
    print(f"check-plan: {'PASS' if first_failure == 0 else 'FAIL'}. {summary}.{not_run}")
    return first_failure


def cmd_receipt(args):
    argv = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not argv:
        raise SystemExit("receipt: give the command after --")
    if args.findings or args.fix_base:
        guard, tools, inputs, problem, _ = capability_command("test-guard", args)
        return run_with_receipt(args.name, [*guard, "--", *argv], cwd=Path.cwd(), tools=[*args.tool, *tools],
                                inputs=[*args.input, *inputs], receipts=args.receipts, base=args.base,
                                root=Path(args.root).resolve() if args.root else REPO, skip_reason=problem,
                                required=True, spend=spend_fields(args))
    return run_with_receipt(args.name, argv, cwd=Path.cwd(), tools=args.tool, inputs=args.input,
                            receipts=args.receipts, base=args.base, root=Path(args.root).resolve() if args.root else REPO,
                            spend=spend_fields(args))


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
    if (args.checkout or args.allow_drop) and not args.relock:
        raise SystemExit("bootstrap: --checkout and --allow-drop are only used with --relock")
    if args.relock:
        try:
            base = skills_dir(args.skills_dir)
        except ValueError as error:
            raise SystemExit(f"bootstrap --relock: FAIL. {error}") from None
        lock = load_lock()
        groups = {name: row["group"] for name, row in lock["skills"].items()}
        if args.checkout or args.allow_drop:
            raise SystemExit("bootstrap --relock: upstream comparison and pstack relocking are retired; "
                             "omit --checkout/--allow-drop to relock independent leaf skills only")
        missing = [name for name in sorted(groups) if not (base / name / "SKILL.md").is_file()]
        if missing:
            raise SystemExit(f"bootstrap --relock: missing skills {', '.join(missing)}")
        lock["skills"] = {}
        for name in sorted(groups):
            digest, count = tree_hash(base / name)
            lock["skills"][name] = {"group": groups[name], "files": count, "sha256": digest}
        LOCK_PATH.write_text(json.dumps(lock, indent=2) + "\n")
        print(f"bootstrap: relocked {len(groups)} skills from {redact(base)}. Review and commit {LOCK_PATH.relative_to(REPO)}.")
        return 0
    source, _, problem = pstack_source(args.skills_dir)
    if problem:
        return cmd_doctor(args)
    base = Path(source["skillsDir"])
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
        "lockSha256": sha256_file(LOCK_PATH), "pstack": redacted(source), "at": now().isoformat(),
    }, indent=2) + "\n")
    print(f"bootstrap: PASS. {redact(link)} {action} -> {redact(base)}. No global files were written.")
    return 0


def usd(value):
    try:
        amount = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("USD must be a finite nonnegative number") from None
    if not math.isfinite(amount) or amount < 0:
        raise argparse.ArgumentTypeError("USD must be a finite nonnegative number")
    return amount


def spend_fields(args):
    return {"actualUsd": args.actual_usd, "actualSource": args.actual_source, "targetUsd": args.target_usd,
            "capUsd": None, "capEnforced": False}


def cmd_escalate(args):
    """Record a bounded request or its outcome locally; dispatch and Linear writes belong to the coordinator."""
    issue_pattern = r"[A-Z][A-Z0-9]*-[1-9][0-9]*"
    if not re.fullmatch(issue_pattern, args.issue) or not re.fullmatch(issue_pattern, args.source_issue):
        raise SystemExit("escalate: issue and source issue must be Linear IDs, e.g. GRS-104")
    if args.issue == args.source_issue or not re.fullmatch(
            rf"https://linear\.app/[^/?#]+/issue/{re.escape(args.issue)}(?:/[^?#]*)?", args.issue_url):
        raise SystemExit("escalate: give a separate linked escalation issue URL matching --issue")
    if not FULL_ID.fullmatch(args.sha) or not 1 <= len(args.question.strip()) <= 1000:
        raise SystemExit("escalate: give an exact SHA and a bounded question (1-1000 characters)")
    if args.phase == "outcome" and not all(value and value.strip() for value in
            (args.task_id, args.findings, args.outcome, args.checks)):
        raise SystemExit("escalate: outcome requires --task-id, --findings, --outcome and --checks")
    root = Path(args.root).resolve() if args.root else REPO
    identity, problem = revision(root, args.base)
    if problem or identity["head"] != args.sha or identity["dirty"]:
        raise SystemExit(f"escalate: needs the exact clean HEAD SHA; {problem or 'SHA differs or checkout is dirty'}")
    record = {"issue": args.issue, "issueUrl": args.issue_url, "sourceIssue": args.source_issue, "sha": args.sha,
              "question": args.question.strip(), "model": args.model, "effort": "xhigh", "attemptLimit": 1,
              "phase": args.phase, "taskId": args.task_id, "findings": args.findings,
              "outcome": args.outcome, "checks": args.checks, "dispatchPerformed": False}
    # Use the same revision/capture checks as command receipts, with no network or task launch.
    return run_with_receipt(f"escalation-{args.phase}", [sys.executable, "-I", "-B", "-c",
                            "print('Escalation record only; no dispatch or Linear contact.')"],
                            root=root, cwd=root, receipts=args.receipts, base=args.base, tools=("python3",),
                            required=True, metadata={"escalation": record}, spend=spend_fields(args), expected_head=args.sha)


# Approval ledger ------------------------------------------------------------

def json_object(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must hold a JSON object")
    return value


def timestamp(value):
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a UTC offset")
    return parsed


def canonical_unit(value):
    match = re.fullmatch(r"([A-Z][A-Z0-9]*)-([0-9]+)/(implementation|review)", value, re.IGNORECASE)
    if not match or int(match[2]) < 1:
        raise ValueError("unit must be ORIGINAL-ISSUE/implementation or ORIGINAL-ISSUE/review")
    canonical = f"{match[1].upper()}-{int(match[2])}/{match[3].lower()}"
    if value != canonical:
        raise ValueError(f"noncanonical unit spelling; use {canonical}")
    if redact(canonical) != canonical:  # stored rows hold the unit as displayed, and readers compare it
        raise ValueError(f"HOME names the unit's own suffix, so receipts would redact the unit {canonical}; set HOME "
                         "to a home directory")
    return canonical


def exact_clean(identity, sha):
    if not FULL_ID.fullmatch(sha) or identity["head"] != sha or identity["dirty"]:
        raise ValueError("approval requires the exact clean HEAD SHA")


def passing_check(check, identity):
    if (check.get("schema") != "clearcase-agent-receipt/1" or check.get("result") != "PASS"
            or check.get("exitCode") != 0 or check.get("reason") or not check.get("command")):
        raise ValueError("check receipt is not a complete PASS")
    recorded = check.get("revision", {})
    if (any(recorded.get(key) != identity[key] for key in ("head", "dirty", "diffSha256"))
            or any(exact(recorded, key, "revision") != exact(identity, key, "revision") for key in ("root", "toplevel"))):
        raise ValueError("check receipt revision mismatch (SHA, checkout or dirty state)")
    if not recorded.get("repository") or not FULL_ID.fullmatch(recorded.get("base") or ""):
        raise ValueError("check receipt lacks revision evidence")


def check_artifacts(check):
    artifacts = check.get("artifacts", {})
    if set(artifacts) != {"receipt", "stdout", "stderr"}:
        raise ValueError("check receipt lacks captured artifacts")
    paths = [Path(exact(check, "artifacts", "artifact")[key]).resolve() for key in ("stdout", "stderr")]
    for path in paths:
        file_identity(path)
    return paths


def event_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ledger_events(store):
    log, tip = store / "events.jsonl", store / "events.tip"
    if not log.exists() and not tip.exists():
        return []
    events, previous = [], "0" * 64
    for line in log.read_text().splitlines():
        event = json.loads(line)
        digest = event.pop("hash")
        if event.get("sequence") != len(events) + 1 or event.get("previous") != previous or event_hash(event) != digest:
            raise ValueError("append-only ledger chain is corrupt")
        event["hash"] = digest
        previous = digest
        events.append(event)
    if json_object(tip) != {"sequence": len(events), "hash": previous}:
        raise ValueError("append-only ledger tip mismatch (history truncated or replaced)")
    return events


def append_event(store, kind, payload):
    import fcntl
    store.mkdir(parents=True, exist_ok=True)
    with (store / "events.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        events = ledger_events(store)
        if kind == "review":
            originals = {}
            for prior in events:
                if prior["kind"] == "review" and prior["payload"]["unit"] == payload["unit"]:
                    for finding in prior["payload"]["originalFindings"]:
                        originals.setdefault(finding["id"], finding)
            for finding in payload["originalFindings"]:
                originals.setdefault(finding["id"], finding)
            payload["originalFindings"] = list(originals.values())
        event = {"sequence": len(events) + 1, "previous": events[-1]["hash"] if events else "0" * 64,
                 "kind": kind, "payload": payload}
        event["hash"] = event_hash(event)
        with (store / "events.jsonl").open("a") as log:
            log.write(json.dumps(event, sort_keys=True) + "\n")
            log.flush()
            os.fsync(log.fileno())
        temporary = store / "events.tip.new"
        with temporary.open("w") as tip:
            json.dump({"sequence": event["sequence"], "hash": event["hash"]}, tip)
            tip.flush()
            os.fsync(tip.fileno())
        temporary.replace(store / "events.tip")
        return event


def content_blob(store, path):
    data = Path(path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    blobs = store / "blobs"
    blobs.mkdir(exist_ok=True)
    target = blobs / digest
    try:
        with target.open("xb") as handle:
            handle.write(data)
        target.chmod(0o444)
    except FileExistsError:
        if target.read_bytes() != data:
            raise ValueError("review content-addressed blob corrupt")
    return digest


def review_record(store, unit, review, findings):
    review_hash, findings_hash = sha256_file(review), sha256_file(findings)
    latest = None
    for event in ledger_events(store):
        if event["kind"] != "review":
            continue
        record = event["payload"]
        for key in ("reviewHash", "findingsHash"):
            if sha256_file(store / "blobs" / record[key]) != record[key]:
                raise ValueError("recorded original review/findings content changed")
        if record["unit"] == unit:
            latest = event
    if latest and latest["payload"]["reviewHash"] == review_hash and latest["payload"]["findingsHash"] == findings_hash:
        return latest
    raise ValueError("review/findings differ from the latest review-step record; original severity cannot be rewritten or superseded reviews reused")


def cmd_review_record(args):
    store = receipts_root(args.receipts)
    root = Path(args.root).resolve() if args.root else REPO
    paths = [Path(args.review).resolve(), Path(args.findings).resolve()]
    problem, event = None, None
    try:
        identity, problem = revision(root, args.base)
        if problem:
            raise ValueError(problem)
        canonical_unit(args.unit)
        review, findings = map(json_object, paths)
        exact_clean(identity, review["sha"])
        if review.get("findingsSha256") != sha256_file(paths[1]) or review["unresolvedFindings"] != findings["unresolvedFindings"]:
            raise ValueError("review step must bind findings hash and original severity list")
        # Retain the first severity even if a subsequent review attempts to relabel it.
        originals = {}
        for prior in ledger_events(store):
            if prior["kind"] == "review" and prior["payload"]["unit"] == args.unit:
                for finding in prior["payload"]["originalFindings"]:
                    originals.setdefault(finding["id"], finding)
        for finding in findings["unresolvedFindings"]:
            originals.setdefault(finding["id"], finding)
        store.mkdir(parents=True, exist_ok=True)
        event = append_event(store, "review", {"unit": args.unit, "sha": review["sha"],
                             "reviewHash": content_blob(store, paths[0]), "findingsHash": content_blob(store, paths[1]),
                             "originalFindings": list(originals.values())})
    except (OSError, ValueError, TypeError, KeyError) as error:
        problem = f"review-record: refuse. {error}"
    return run_with_receipt("review-record", [sys.executable, "-I", "-c", "print('review step recorded')"],
                            root=root, cwd=root, receipts=store, base=args.base, inputs=paths, required=True,
                            skip_reason=problem, metadata={"reviewEvent": event["hash"] if event else None})


def fix_state(store, unit):
    """(the first recorded fix dispatch, the review-record that prompted it) for unit in the store's log. The fix
    answers the latest review recorded before it; that review's commit and findings are what the guard must bind."""
    events = ledger_events(store)
    fix = next((e for e in events if e["kind"] == "dispatch" and e["payload"]["row"].get("unit") == unit
                and e["payload"]["row"].get("phase") == "fix" and e["payload"]["row"].get("outcome") == "recorded"), None)
    if fix is None:
        return None, None
    reviews = [e for e in events if e["kind"] == "review" and e["payload"]["unit"] == unit and e["sequence"] < fix["sequence"]]
    return fix, (reviews[-1] if reviews else None)


def guard_binding(store, unit, supplied, identity):
    """(binding, evidence paths). A unit with a recorded fix attempt needs a PASS test-guard receipt at the approved
    HEAD whose fix base is the commit the prompting review recorded, whose manifest names that review's findings by
    content hash and lists exactly the tests that review protects. None when no fix attempt is recorded."""
    fix, prompting = fix_state(store, unit)
    if fix is None:
        return None, []
    if prompting is None:
        raise ValueError("a fix attempt is recorded for this unit with no review-record before it")
    record = prompting["payload"]
    protected = json_object(store / "blobs" / record["findingsHash"]).get("protectedTests")
    if not isinstance(protected, list):
        raise ValueError("the review that prompted the fix lists no protectedTests (a list of {file, name}; empty "
                         "only when it names no test); the guard cannot be bound to it")
    binding = {"nothingToProtect": not protected, "reviewEvent": prompting["hash"], "fixEvent": fix["hash"], "fixBase": record["sha"]}
    if not protected:
        return binding, []
    if not supplied:
        raise ValueError("a fix attempt is recorded for this unit: approval needs the PASS test-guard receipt "
                         "(--guard-receipt) bound to the reviewed commit and findings")
    path = Path(supplied).expanduser().resolve()
    receipt = json_object(path)
    passing_check(receipt, identity)
    claims = receipt.get("guard") if receipt.get("name") == "test-guard" else None
    if not isinstance(claims, dict):
        raise ValueError("the guard receipt is not a test-guard receipt")
    if claims.get("fixBase") != record["sha"]:
        raise ValueError(f"guard fix base {str(claims.get('fixBase'))[:12]} differs from the reviewed SHA {record['sha'][:12]} in the ledger")
    if claims.get("reviewFindingsSha256") != record["findingsHash"] or claims.get("unit") != unit:
        raise ValueError("the guard manifest names other review findings than the ledger's review for this unit")
    if json.dumps(exact(claims, "tests", "guard"), sort_keys=True) != json.dumps(protected, sort_keys=True):
        raise ValueError("the guard manifest's tests differ from the review's protectedTests")
    return {**binding, "receipt": str(path), "manifestSha256": claims.get("manifestSha256"), "tests": protected}, [path]


def approval_evidence(args, identity, paths):
    review_path, findings_path = Path(args.review).resolve(), Path(args.findings).resolve()
    paths.extend([review_path, findings_path])
    event = review_record(receipts_root(args.receipts), args.unit, review_path, findings_path)
    record = event["payload"]
    paths.extend([receipts_root(args.receipts) / "blobs" / record[key] for key in ("reviewHash", "findingsHash")])
    review, findings = [json_object(receipts_root(args.receipts) / "blobs" / record[key]) for key in ("reviewHash", "findingsHash")]
    if (review.get("schema") != "clearcase-review/1" or review.get("sha") != args.sha
            or findings.get("sha") != args.sha or review.get("verdict") != "PASS"):
        raise ValueError("review verdict, findings and approval must name the same SHA and a PASS review")
    if (review.get("fresh") is not True or not review.get("reviewer") or not review.get("implementer")
            or review["reviewer"] == review["implementer"]):
        raise ValueError("a fresh, distinct reviewer and implementer must be recorded")
    if (findings_path.stat().st_mtime_ns > review_path.stat().st_mtime_ns
            or timestamp(findings["updatedAt"]) > timestamp(review["reviewedAt"])):
        raise ValueError("finding list is newer than the review")
    if review.get("findingsSha256") != sha256_file(findings_path):
        raise ValueError("finding list hash differs from the review")
    unresolved = findings.get("unresolvedFindings")
    if not isinstance(unresolved, list) or review.get("unresolvedFindings") != unresolved:
        raise ValueError("review must bind the exact unresolved findings list")
    original_severity = {finding["id"]: finding["severity"] for finding in record["originalFindings"]}
    for finding in unresolved:
        if isinstance(finding, dict) and original_severity.get(finding.get("id")) != finding.get("severity"):
            raise ValueError("finding severity differs from original review-step record")
        if (not isinstance(finding, dict) or not finding.get("id")
                or finding.get("severity") not in ("low", "P2")):
            raise ValueError("unresolved P0/high, P1/medium or unknown severity blocks approval")
    required = review.get("requiredChecks")
    if (not isinstance(required, list) or not required or any(not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip() for item in required)
            or len({item["name"] for item in required}) != len(required)):
        raise ValueError("review.requiredChecks must bind a nonempty unique set of {name, execution, inputs}; names alone refuse")
    requirements = {item["name"]: item for item in required}
    checks = {}
    for supplied in args.check_receipt:
        path = Path(supplied).expanduser().resolve()
        paths.append(path)
        check = json_object(path)
        passing_check(check, identity)
        name = check.get("name")
        if not isinstance(name, str) or name in checks:
            raise ValueError("check receipt names must be unique")
        if name not in requirements:
            raise ValueError("check name is absent from reviewed requirements")
        paths.extend(validate_execution(check, requirements[name]))
        paths.extend(check_artifacts(check))
        checks[name] = str(path)
    if set(checks) != set(requirements):
        raise ValueError(f"required check receipt mismatch: expected {required}, got {list(checks)}")
    guard, guard_paths = guard_binding(receipts_root(args.receipts), args.unit, args.guard_receipt, identity)
    paths.extend(guard_paths)
    # approval-check reads the review, findings, check receipts and guard binding back from their exact twins.
    return {"state": "approved", "unit": args.unit, "sha": args.sha, "approvedBy": args.approved_by, "guard": guard,
            "guardExact": each_string(guard, seal), "reviewer": review["reviewer"], "reviewVerdict": review["verdict"],
            "review": str(review_path), "reviewExact": seal(review_path), "findings": str(findings_path),
            "findingsExact": seal(findings_path), "unresolvedFindings": unresolved, "checks": checks,
            "checksExact": each_string(checks, seal), "requirements": requirements, "reviewEvent": event["hash"]}


def approval_event(store, receipt, path):
    """The approval receipt at path is a ledger row only when the store's append-only log holds its event unchanged."""
    for event in ledger_events(store):
        if event["kind"] == "approval" and event["hash"] == receipt.get("approvalEvent"):
            payload = event["payload"]
            if (Path(payload["receipt"]).expanduser().resolve() != path or payload["row"] != receipt.get("approval")
                    or payload["inputs"] != receipt.get("inputs")):
                raise ValueError("approval receipt differs from its append-only ledger event")
            return event
    raise ValueError("approval receipt has no event in the ledger store's append-only log")


def cmd_approval(args):
    root = Path(args.root).resolve() if args.root else REPO
    identity, problem = revision(root, args.base)
    paths = []
    row = {"state": "refuse", "unit": args.unit, "sha": args.sha}
    try:
        if problem:
            raise ValueError(problem)
        exact_clean(identity, args.sha)
        canonical_unit(args.unit)
        if args.cmd == "approve":
            if not args.approved_by.strip():
                raise ValueError("approved-by must be nonempty")
            row = approval_evidence(args, identity, paths)
        else:
            ledger_path = Path(args.approval_receipt).expanduser().resolve()
            paths.append(ledger_path)
            ledger = json_object(ledger_path)
            passing_check(ledger, identity)
            row = ledger.get("approval", {})
            if row.get("state") != "approved" or row.get("sha") != args.sha or row.get("unit") != args.unit:
                raise ValueError("approval ledger unit/SHA/state mismatch")
            approval_event(receipts_root(args.receipts), ledger, ledger_path)
            recorded = ledger.get("inputs")
            if not isinstance(recorded, list) or not recorded:
                raise ValueError("approval ledger lacks evidence fingerprints")
            originals = exact_input_paths(recorded)
            changed = inputs_changed(originals, recorded)
            if changed:
                raise ValueError(f"approval evidence changed: {changed}")
            event = review_record(receipts_root(args.receipts), args.unit, Path(exact(row, "review", "approval")),
                                  Path(exact(row, "findings", "approval")))
            if event["hash"] != row["reviewEvent"]:
                raise ValueError("approval review-step record mismatch")
            bound = exact(row, "guard", "approval")
            guard, guard_paths = guard_binding(receipts_root(args.receipts), args.unit, (bound or {}).get("receipt"), identity)
            if guard != bound:
                raise ValueError("approval row lacks the test-guard binding the ledger now requires for this unit")
            paths.extend(guard_paths)
            checks = exact(row, "checks", "approval")
            for name, requirement in row["requirements"].items():
                check = json_object(Path(checks[name]))
                passing_check(check, identity)
                paths.extend(validate_execution(check, requirement))
            paths.extend(originals)
            paths.extend(check_artifacts(ledger))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        problem = f"approval: refuse. {error}"
        row = {"state": "refuse", "unit": args.unit, "sha": args.sha}
    return run_with_receipt(args.cmd, [sys.executable, "-I", "-B", "-c", "print('approval: approved')"],
                            cwd=root, root=root, tools=["python3"], inputs=paths, receipts=args.receipts,
                            base=args.base, skip_reason=problem, required=True, expected_head=args.sha,
                            metadata={"approval": row}, spend=spend_fields(args))


# Local dispatch bookkeeping (records only; never launches or cancels a process)

DISPATCH_PHASES = ("initial", "fix", "recheck", "escalation", "infra-retry")


def dispatch_record(args, root, store, row):
    canonical_unit(args.unit)
    identity, problem = revision(root, args.base)
    if problem or identity["dirty"]:
        raise ValueError(problem or "dispatch bookkeeping requires a clean revision")
    events = ledger_events(store)
    history = []
    for event in events:
        if event["kind"] != "dispatch":
            continue
        payload = event["payload"]
        receipt = json_object(Path(payload["receipt"]).expanduser())
        prior = receipt.get("dispatch")
        if prior != payload["row"] or receipt.get("dispatchEvent") != event["hash"]:
            raise ValueError("stored attempt record/counts mismatch with append-only event")
        if prior.get("unit") != args.unit:
            continue
        if prior.get("outcome") == "recorded":
            phase = prior["phase"]
            row["counts"][phase] += 1
            if row["counts"][phase] > 1 or prior.get("counts") != row["counts"]:
                raise ValueError("stored attempt counts mismatch with derived events")
        history.append(prior)
    # A receipt without its event is also corrupt; do not silently adopt legacy mutable history.
    indexed = {event["hash"] for event in events if event["kind"] == "dispatch"}
    for path in sorted(store.glob("*/receipt.json")):
        receipt = json_object(path)
        if "dispatch" in receipt and receipt.get("dispatchEvent") not in indexed:
            raise ValueError("attempt receipt is missing its append-only event")
    # Each attempt carries its own deadline; the unit's first (initial) deadline stays in "deadline" for reference.
    row["deadlines"] = {prior["phase"]: prior.get("attemptDeadline") or prior.get("deadline")
                        for prior in history if prior.get("outcome") == "recorded" and (prior.get("attemptDeadline") or prior.get("deadline"))}
    row["deadline"] = row["deadlines"].get("initial")
    if args.phase == "cancel":
        if not row["counts"]["initial"] or not args.cancel_outcome or not (args.reason or "").strip():
            raise ValueError("cancellation requires an existing unit, --cancel-outcome and --reason")
        row.update(outcome="cancelled" if args.cancel_outcome == "confirmed" else "cancellation-failed",
                   cancellation={"outcome": args.cancel_outcome, "reason": args.reason,
                                 "taskId": args.task_id, "performedByTool": False})
        return None if args.cancel_outcome == "confirmed" else "cancellation not confirmed; unit stopped"
    if any(prior.get("cancellation") for prior in history):
        raise ValueError("unit has a cancellation record; no further attempts")
    if args.phase == "initial":
        if row["deadline"] and args.deadline != row["deadline"]:
            raise ValueError("the initial deadline cannot be changed by a restart or a renamed task")
        if not args.deadline:
            raise ValueError("initial attempt requires --deadline before dispatch")
    elif not row["counts"]["initial"]:
        raise ValueError("record the initial attempt and deadline first")
    # Every attempt, not only the first, is bounded when it is dispatched: in the future, within the unit's limit.
    limit = 90 if args.unit.endswith("/implementation") else 30
    attempt = args.deadline or (now() + datetime.timedelta(minutes=limit)).isoformat()
    if not 0 < (timestamp(attempt) - now()).total_seconds() <= limit * 60:
        raise ValueError(f"the {args.phase} deadline must be in the future within {limit} minutes of its dispatch")
    if args.phase == "recheck" and not row["counts"]["fix"]:
        raise ValueError("recheck requires the unit's written-finding fix round")
    if args.phase == "escalation" and not row["counts"]["recheck"]:
        raise ValueError("escalation bookkeeping requires the unit's recheck")
    if row["counts"][args.phase]:
        raise ValueError(f"bounded attempts exhausted: one {args.phase} per original issue/stage")
    if all(row["counts"][phase] for phase in ("fix", "recheck", "escalation")):
        raise ValueError("bounded unit exhausted: one fix, one recheck and one escalation")
    if args.failure:
        if not (args.diagnosis or "").strip():
            raise ValueError("a failure fingerprint requires --diagnosis")
        if any(prior.get("outcome") == "recorded" and exact(prior, "failure", "dispatch") == args.failure
               and exact(prior, "diagnosis", "dispatch") == args.diagnosis for prior in history):
            raise ValueError("same failure twice without a new diagnosis; stop this unit")
    row["counts"][args.phase] += 1
    row["attemptDeadline"] = attempt
    row["deadlines"][args.phase] = attempt
    row["deadline"] = row["deadline"] or attempt
    row["outcome"] = "recorded"
    return None


def cmd_dispatch(args):
    import fcntl
    root = Path(args.root).resolve() if args.root else REPO
    store = receipts_root(args.receipts)
    row = {"unit": args.unit, "phase": args.phase, "taskId": args.task_id, "deadline": None, "attemptDeadline": None,
           "deadlines": {},
           "counts": dict.fromkeys(DISPATCH_PHASES, 0), "outcome": "refuse", "dispatchPerformed": False,
           "failure": args.failure, "failureExact": each_string(args.failure, seal), "diagnosis": args.diagnosis,
           "diagnosisExact": each_string(args.diagnosis, seal)}
    # Keep the receipt append under the same lock as the read; concurrent reservations cannot both win.
    try:
        store.mkdir(parents=True, exist_ok=True)
        with (store / "dispatch.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                if not args.task_id.strip():
                    raise ValueError("task-id must be nonempty")
                problem = dispatch_record(args, root, store, row)
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                problem = str(error)
                row["outcome"] = "refuse"
            row["reason"] = problem
            return run_with_receipt("dispatch", [sys.executable, "-I", "-B", "-c", "print('dispatch: local record only')"],
                                    cwd=root, root=root, tools=["python3"], receipts=store, base=args.base,
                                    skip_reason=problem, required=True, metadata={"dispatch": row}, spend=spend_fields(args))
    except OSError as error:
        sys.stderr.write(f"dispatch: refuse. cannot lock receipt store: {error}\n")
        return 1


# Push and CI callers -----------------------------------------------------------

LEDGER_COMMANDS = ("review-record", "approve", "approval-check", "dispatch", "pre-push")
FEATURE_REF = re.compile(r"refs/heads/feature/([a-z][a-z0-9]*-[0-9]+)(?:-.+)?")
FIX_ROUNDS = "docs/acceptance/fix-rounds"


def ledger_store(args):
    """The ledger store as (path, problem): --ledger, else CLEARCASE_LEDGER_DIR, else the receipt store. It must lie
    outside the checkout it checks, so the worker's own tree, git clean and worktree removal cannot reach it."""
    root = Path(args.root).resolve() if args.root else REPO
    _, out, problem = git(root, "rev-parse", "--show-toplevel")
    top = root if problem else Path(os.fsdecode(out.rstrip(b"\n"))).resolve()
    chosen = args.ledger or os.environ.get("CLEARCASE_LEDGER_DIR")
    if chosen and not Path(chosen).expanduser().is_absolute():
        return Path(chosen), (f"{args.cmd}: refuse. the ledger directory {chosen!r} must be an absolute path: a relative one "
                              "resolves against each caller's working directory and splits the store")
    store = Path(chosen or receipts_root(args.receipts)).expanduser().resolve()
    if any(store == checkout or checkout in store.parents for checkout in (root, top)):
        return store, (f"{args.cmd}: refuse. the ledger store {redact(store)} must be outside the checkout {redact(root)}; "
                       "pass --ledger DIR or set CLEARCASE_LEDGER_DIR to the coordinator's store (docs/agent-tooling.md)")
    return store, None


def cmd_pre_push(args):
    """The repo-side half of the coordinator's pre-push hook. Reads the hook's stdin; each pushed feature branch needs
    an approved ledger row for the exact commit and the branch's Linear issue, rechecked by approval-check. Other refs
    and deletions pass here; the hook keeps its own rules for them."""
    store, status = receipts_root(args.receipts), 0
    for line in sys.stdin.read().splitlines():
        words = line.split()
        if not words:
            continue
        if len(words) != 4:
            sys.stderr.write(f"pre-push: BLOCKED: unreadable ref line {line!r}\n")
            status = 1
            continue
        _, sha, ref, _ = words
        if re.fullmatch(r"0+", sha) or not ref.startswith("refs/heads/feature/"):
            continue
        match = FEATURE_REF.fullmatch(ref)
        try:
            if not match:
                raise ValueError("the branch names no Linear issue (feature/<linear-id>-<slug>)")
            unit = canonical_unit(f"{match[1].upper()}/implementation")
            rows = [event["payload"] for event in ledger_events(store) if event["kind"] == "approval"
                    and event["payload"]["row"].get("unit") == unit and event["payload"]["row"].get("sha") == sha]
            if not rows:
                raise ValueError(f"no approved ledger row for {unit} at this commit in {redact(store)}")
            check = argparse.Namespace(**{**vars(args), "cmd": "approval-check", "unit": unit, "sha": sha,
                                          "approval_receipt": rows[-1]["receipt"]})
            if cmd_approval(check) != 0:
                raise ValueError("approval-check refused its approval (above)")
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            sys.stderr.write(f"pre-push: BLOCKED: {ref} at {sha}: {error}\n")
            status = 1
    return status


def cmd_fix_round_guard(args):
    """CI's half of the test guard: runs it at HEAD for each fix-round manifest added or changed since the merge base
    with --base. A manifest is the fix round's review findings plus the reviewed fixBase; deleting one refuses."""
    root = Path(args.root).resolve() if args.root else REPO
    identity, problem = revision(root, args.base)
    _, out, problem = (None, b"", problem) if problem else git(
        root, "diff", "--name-status", "--no-renames", "-z", identity["mergeBase"], identity["head"], "--", FIX_ROUNDS)
    if problem:
        sys.stderr.write(f"fix-round-guard: FAIL. {problem}\n")
        return 1
    fields = os.fsdecode(out).split("\0")[:-1]
    changes = list(zip(fields[::2], fields[1::2]))
    status = 0
    for kind, path in changes:
        if kind == "D":
            sys.stderr.write(f"fix-round-guard: FAIL {path}: deleted; a fix round's protection cannot be withdrawn\n")
            status = 1
    manifests = [path for kind, path in changes if kind != "D" and path.endswith(".json")]
    required = "the pull request carries the fix-round label" if args.require_manifest else None
    match = FEATURE_REF.fullmatch(f"refs/heads/{args.branch or ''}")
    if not required and args.ledger and match:
        unit = canonical_unit(f"{match[1].upper()}/implementation")
        if fix_state(Path(args.ledger).expanduser().resolve(), unit)[0]:
            required = f"the ledger records a fix attempt for {unit}"
    if not manifests and not status and required:
        sys.stderr.write(f"fix-round-guard: FAIL. {required}, but no fix-round manifest was added or changed under "
                         f"{FIX_ROUNDS}/ since {identity['mergeBase'][:12]}; a fix round commits one (docs/agent-tooling.md)\n")
        return 1
    if not manifests and not status:
        print(f"fix-round-guard: no fix-round manifest added or changed under {FIX_ROUNDS}/ since "
              f"{identity['mergeBase'][:12]}; nothing to protect")
        return run_with_receipt("fix-round-guard", [sys.executable, "-I", "-B", "-c", "print('nothing to protect')"], cwd=root,
                                root=root, tools=["python3"], receipts=args.receipts, base=args.base, required=True,
                                metadata={"guard": {"nothingToProtect": True, "mergeBase": identity["mergeBase"]}},
                                spend=spend_fields(args))
    for path in manifests:
        try:
            manifest = json_object(root / path)
            if manifest.get("schema") != "clearcase-fix-round/1":
                raise ValueError("schema must be clearcase-fix-round/1")
            unit = canonical_unit(str(manifest.get("unit")))
            if not isinstance(manifest.get("fixBase"), str) or not FULL_ID.fullmatch(manifest["fixBase"]):
                raise ValueError("fixBase must be the full SHA of the reviewed commit")
            # The manifest is the fix worker's file. With the coordinator's ledger, the reviewed commit and findings come
            # from the review it recorded before the first fix; CI has no ledger and relies on the approval binding.
            fix, prompting = fix_state(Path(args.ledger).expanduser().resolve(), unit) if args.ledger else (None, None)
            if fix is not None and prompting is None:
                raise ValueError(f"the ledger records a fix attempt for {unit} with no review-record before it")
            if fix is not None and manifest["fixBase"] != prompting["payload"]["sha"]:
                raise ValueError(f"fixBase {manifest['fixBase'][:12]} is not the reviewed commit "
                                 f"{prompting['payload']['sha'][:12]} the ledger recorded for {unit}")
            if fix is not None and manifest.get("reviewFindingsSha256") != prompting["payload"]["findingsHash"]:
                raise ValueError(f"reviewFindingsSha256 names other findings than the review the ledger recorded for {unit}")
        except (OSError, ValueError) as error:
            sys.stderr.write(f"fix-round-guard: FAIL {path}: {error}\n")
            status = 1
            continue
        guard = argparse.Namespace(**{**vars(args), "findings": str(root / path), "fix_base": manifest["fixBase"]})
        status = run_capability("test-guard", guard) or status
    return 1 if status else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agent-tools")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--skills-dir", help="independent leaf skills / legacy fallback (default: $CLEARCASE_SKILLS_DIR or ~/.agents/skills)")
        p.add_argument("--actual-usd", type=usd, help="reported actual spend, with --actual-source")
        p.add_argument("--actual-source", help="provider usage export or billing source for --actual-usd")
        p.add_argument("--target-usd", type=usd, help="reporting-only spend target; never an enforcement cap")
        p.add_argument("--receipts", help="receipt directory (default: $CLEARCASE_RECEIPTS_DIR or .local/agent-receipts)")
        p.add_argument("--base", help="base ref recorded in receipts; must resolve to a commit "
                                      "(default: $CLEARCASE_BASE_REF, then origin/dev, then dev)")
        p.add_argument("--fix-base", help="reviewed ancestor for test protection")
        p.add_argument("--root", help="repository root to check (default: this checkout)")
        return p

    common(sub.add_parser("doctor")).set_defaults(func=cmd_doctor)
    boot = common(sub.add_parser("bootstrap"))
    mode = boot.add_mutually_exclusive_group()
    mode.add_argument("--relock", action="store_true")
    mode.add_argument("--remove", action="store_true")
    boot.add_argument("--checkout", help="retired pstack relock option; refused with a migration message")
    boot.add_argument("--allow-drop", action="store_true", help="retired pstack relock option; refused")
    boot.set_defaults(func=cmd_bootstrap)
    check = common(sub.add_parser("check-plan"))
    check.add_argument("--linear-relations", metavar="READBACK")
    check.add_argument("--require-linear-relations", action="store_true")
    check.add_argument("--plan", help="plan for the plan-format step (default: docs/delivery-plan.md)")
    check.set_defaults(func=cmd_check_plan)
    verify = common(sub.add_parser("verify"))
    verify.add_argument("capability", choices=["list", *CAPABILITIES])
    verify.add_argument("--findings", help="findings JSON naming protected tests")
    verify.add_argument("--model-sheet", help="sheet path (default: XDG config t3-pstack/models.md)")
    verify.add_argument("--catalog", help="fresh orchestrator_capabilities JSON with capturedAt")
    verify.add_argument("--readback", help="Linear readback JSON for linear-relations")
    verify.add_argument("--plan", help="plan for plan-format (default: docs/delivery-plan.md) or pstack-plan-format (required)")
    verify.add_argument("--checkout", help="retired; accepted so an old caller reaches the migration FAIL, never used")
    verify.set_defaults(func=cmd_verify)
    guard = common(sub.add_parser("test-guard"))
    guard.add_argument("--findings")
    guard.set_defaults(func=lambda args: run_capability("test-guard", args))
    compare = common(sub.add_parser("compare-upstream"))
    compare.add_argument("--checkout", help="retired; accepted so an old caller reaches the migration FAIL, never used")
    compare.set_defaults(func=cmd_compare_upstream)
    receipt = common(sub.add_parser("receipt"))
    receipt.add_argument("--findings", help="run test protection before the command")
    receipt.add_argument("--name", required=True)
    receipt.add_argument("--tool", action="append", default=[], help="required tool to version-probe; missing means SKIPPED")
    receipt.add_argument("--input", action="append", default=[], help="input file to fingerprint; missing means SKIPPED")
    receipt.add_argument("command", nargs=argparse.REMAINDER)
    receipt.set_defaults(func=cmd_receipt)
    escalation = common(sub.add_parser("escalate"))
    escalation.add_argument("--issue", required=True, help="linked Linear escalation issue ID")
    escalation.add_argument("--issue-url", required=True, help="URL linking the escalation issue")
    escalation.add_argument("--source-issue", required=True)
    escalation.add_argument("--sha", required=True, help="exact clean HEAD SHA")
    escalation.add_argument("--question", required=True, help="bounded question, 1-1000 characters")
    escalation.add_argument("--model", required=True, choices=("claude-fable-5-1", "gpt-6-astra"))
    escalation.add_argument("--phase", choices=("request", "outcome"), default="request")
    escalation.add_argument("--task-id")
    escalation.add_argument("--findings")
    escalation.add_argument("--outcome")
    escalation.add_argument("--checks")
    escalation.set_defaults(func=cmd_escalate)
    review_step = common(sub.add_parser("review-record"))
    review_step.add_argument("--unit", required=True)
    review_step.add_argument("--review", required=True)
    review_step.add_argument("--findings", required=True)
    review_step.set_defaults(func=cmd_review_record)
    for name in ("approve", "approval-check"):
        approval = common(sub.add_parser(name))
        approval.add_argument("--unit", required=True)
        approval.add_argument("--sha", required=True)
        if name == "approve":
            approval.add_argument("--review", required=True)
            approval.add_argument("--findings", required=True)
            approval.add_argument("--check-receipt", action="append", required=True)
            approval.add_argument("--approved-by", required=True)
            approval.add_argument("--guard-receipt", help="PASS test-guard receipt; required once a fix attempt is recorded")
        else:
            approval.add_argument("--approval-receipt", required=True)
        approval.set_defaults(func=cmd_approval)
    dispatch = common(sub.add_parser("dispatch"))
    dispatch.add_argument("--unit", required=True)
    dispatch.add_argument("--task-id", required=True)
    dispatch.add_argument("--phase", required=True, choices=(*DISPATCH_PHASES, "cancel"))
    dispatch.add_argument("--deadline")
    dispatch.add_argument("--cancel-outcome", choices=("confirmed", "failed"))
    dispatch.add_argument("--reason")
    dispatch.add_argument("--failure", help="stable failure fingerprint")
    dispatch.add_argument("--diagnosis")
    dispatch.set_defaults(func=cmd_dispatch)
    push = common(sub.add_parser("pre-push"))
    push.add_argument("remote", nargs="?", help="the hook's remote name; unused")
    push.add_argument("url", nargs="?", help="the hook's remote URL; unused")
    push.set_defaults(func=cmd_pre_push)
    fix_guard = common(sub.add_parser("fix-round-guard"))
    fix_guard.add_argument("--ledger", help="the coordinator's ledger store, read only: a recorded fix attempt for the "
                                            "branch's unit makes a missing manifest a failure")
    fix_guard.add_argument("--branch", help="the pull request's head branch (feature/<linear-id>-<slug>)")
    fix_guard.add_argument("--require-manifest", action="store_true",
                           help="fail when no manifest was added or changed (the pull request carries the fix-round label)")
    fix_guard.set_defaults(func=cmd_fix_round_guard)
    for name in LEDGER_COMMANDS:
        sub.choices[name].add_argument("--ledger", help="coordinator's ledger store outside the checkout "
                                                        "(default: $CLEARCASE_LEDGER_DIR, then the receipt store)")
    args = parser.parse_args(argv)
    if (args.actual_usd is None) != (args.actual_source is None) or args.actual_source is not None and not args.actual_source.strip():
        parser.error("--actual-usd and a nonempty --actual-source must be supplied together")
    if args.cmd in LEDGER_COMMANDS:
        store, problem = ledger_store(args)
        if problem:
            sys.stderr.write(problem + "\n")
            return 1
        args.receipts = str(store)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
