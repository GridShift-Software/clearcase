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
APP_DEFERRED = (
    "No application exists yet. App, build and browser verification (a project verify-<app> skill "
    "generated with pstack create-verification-skill) is deferred to GRS-12 (CC-03), which establishes "
    "the app, build and browser commands. GRS-10 (CC-02) owns the npm/TypeScript/Vitest bootstrap."
)
IGNORED_PARTS = {"node_modules", "__pycache__", ".DS_Store"}


def redact(value):
    text = str(value)
    return text.replace(HOME, "~") if HOME and HOME != "/" else text


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def first_line(argv):
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)
    text = (out.stdout or out.stderr).strip().splitlines()
    return out.returncode, text[0] if text else ""


def which(name):
    override = os.environ.get(f"CLEARCASE_{name.upper().replace('3', '')}")
    if override:
        return override if os.access(override, os.X_OK) else None
    if name == "python3":
        return sys.executable
    return shutil.which(name)


def parse_version(text):
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    return tuple(int(part) for part in match.groups() if part is not None) if match else None


def tool_info(name):
    path = which(name)
    if not path:
        return {"name": name, "path": None, "version": None}
    _, version = first_line([path, "-V" if name == "tmux" else "--version"])
    return {"name": name, "path": redact(path), "version": version}


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def manifest(directory):
    """Relative path -> file sha256 (or symlink target) in hashing order, without IGNORED_PARTS."""
    rows = {}
    for path in sorted(p for p in Path(directory).rglob("*") if p.is_file() or p.is_symlink()):
        rel = path.relative_to(directory)
        if not IGNORED_PARTS.intersection(rel.parts):
            rows[rel.as_posix()] = os.readlink(path).encode() if path.is_symlink() else bytes.fromhex(sha256_file(path))
    return rows


def tree_hash(directory):
    digest, rows = hashlib.sha256(), manifest(directory)
    for rel, content in rows.items():
        digest.update(rel.encode() + b"\0" + content + b"\n")
    return digest.hexdigest(), len(rows)


def upstream_diff(upstream, installed):
    """diff -rq between an upstream skill directory and its installed copy, with the pin's exclusions."""
    theirs, ours = manifest(upstream), manifest(installed)
    return [f"{rel} {'only in the checkout' if rel not in ours else 'only installed' if rel not in theirs else 'differs'}"
            for rel in sorted(theirs.keys() | ours.keys()) if theirs.get(rel) != ours.get(rel)]


def pstack_upstream(checkout, base):
    """The skills in a pstack checkout, split into installed in base and not installed."""
    names = {path.parent.name for path in (checkout / "skills").glob("*/SKILL.md")}
    installed = {name for name in names if (base / name / "SKILL.md").is_file()}
    return installed, names - installed


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


def git(root, *args):
    out = subprocess.run(["git", "-C", str(root), *args], capture_output=True) if shutil.which("git") else None
    return out.stdout.decode(errors="replace").strip() if out and out.returncode == 0 else None


def revision(root, base_ref=None):
    head = git(root, "rev-parse", "HEAD")
    if head is None:
        return {"repository": False, "root": redact(root)}
    refs = [base_ref] if base_ref else [os.environ.get("CLEARCASE_BASE_REF"), "origin/dev", "dev"]
    base_ref = next((ref for ref in refs if ref and git(root, "rev-parse", "--verify", "-q", ref)), None)
    status = git(root, "status", "--porcelain") or ""
    digest = hashlib.sha256((git(root, "diff", "HEAD", "--binary") or "").encode())
    for name in (git(root, "ls-files", "--others", "--exclude-standard") or "").splitlines():
        digest.update(name.encode() + b"\0" + bytes.fromhex(sha256_file(Path(root) / name)))
    return {
        "repository": True,
        "root": redact(root),
        "branch": git(root, "rev-parse", "--abbrev-ref", "HEAD"),
        "head": head,
        "baseRef": base_ref,
        "base": git(root, "rev-parse", base_ref) if base_ref else None,
        "mergeBase": git(root, "merge-base", "HEAD", base_ref) if base_ref else None,
        "dirty": bool(status),
        "diffSha256": digest.hexdigest() if status else None,
    }


def receipts_root(explicit=None):
    chosen = explicit or os.environ.get("CLEARCASE_RECEIPTS_DIR") or REPO / ".local/agent-receipts"
    return Path(chosen).expanduser().resolve()


def tee(source, *sinks):
    for chunk in iter(lambda: source.read1(65536), b""):
        for sink in sinks:
            sink.write(chunk)
            sink.flush()
    source.close()


def run_with_receipt(name, argv, *, cwd=None, tools=(), inputs=(), receipts=None, base=None, root=None,
                     skip_reason=None):
    """Run argv, stream and capture its output, and write a receipt. Returns the exit code."""
    root = Path(root or REPO)
    started = now()
    folder = receipts_root(receipts) / f"{started.strftime('%Y%m%dT%H%M%S.%fZ')}-{name}"
    folder.mkdir(parents=True, exist_ok=False)
    stdout_path, stderr_path = folder / "stdout.txt", folder / "stderr.txt"
    tool_rows = [tool_info(tool) for tool in tools]
    missing = [row["name"] for row in tool_rows if row["path"] is None]
    if argv and not missing and not skip_reason and not (shutil.which(argv[0]) or Path(argv[0]).is_file()):
        missing.append(argv[0])
    missing_inputs = [str(path) for path in inputs if not Path(path).is_file()]
    reason = skip_reason or (
        f"required tool not found: {', '.join(missing)}" if missing
        else f"required input not found: {', '.join(redact(p) for p in missing_inputs)}" if missing_inputs
        else None
    )
    if reason:
        stdout_path.write_bytes(b"")
        stderr_path.write_text(f"SKIPPED: {reason}\n")
        sys.stderr.write(f"SKIPPED {name}: {reason}\n")
        code, result = SKIPPED, "SKIPPED"
    else:
        with open(stdout_path, "wb") as out_file, open(stderr_path, "wb") as err_file:
            child = subprocess.Popen(argv, cwd=cwd or root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            threads = [
                threading.Thread(target=tee, args=(child.stdout, out_file, sys.stdout.buffer)),
                threading.Thread(target=tee, args=(child.stderr, err_file, sys.stderr.buffer)),
            ]
            for thread in threads:
                thread.start()
            code = child.wait()
            for thread in threads:
                thread.join()
        result = "PASS" if code == 0 else "FAIL"
    finished = now()
    receipt = {
        "schema": "clearcase-agent-receipt/1",
        "name": name,
        "result": result,
        "exitCode": code,
        "reason": reason,
        "command": [redact(part) for part in argv],
        "cwd": redact(cwd or root),
        "tools": tool_rows,
        "inputs": [
            {"path": redact(Path(p).resolve()), "sha256": sha256_file(p) if Path(p).is_file() else None}
            for p in inputs
        ],
        "revision": revision(root, base),
        "environment": environment(),
        "startedAt": started.isoformat(),
        "finishedAt": finished.isoformat(),
        "durationSeconds": round((finished - started).total_seconds(), 3),
        "artifacts": {
            "receipt": redact(folder / "receipt.json"),
            "stdout": redact(stdout_path),
            "stderr": redact(stderr_path),
        },
    }
    (folder / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    sys.stderr.write(f"receipt: {result} {name} exit={code} {redact(folder / 'receipt.json')}\n")
    sys.stderr.flush()
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

def doctor_rows(skills=None, receipts=None):
    rows = []

    def add(status, name, detail, fix=None):
        rows.append((status, name, detail, fix))

    pretty, os_id = os_release()
    if sys.platform.startswith("linux"):
        add("PASS", "os", f"{pretty} ({os_id}), kernel {platform.release()}")
    else:
        add("FAIL", "os", f"{sys.platform} is unsupported", "use Linux (Arch or CachyOS); see docs/agent-tooling.md")
    add("PASS", "bash", os.environ.get("CLEARCASE_BASH_VERSION") or "unknown (not launched through a wrapper)")
    py = sys.version_info[:2]
    add("PASS" if py >= MIN_PYTHON else "FAIL", "python3", f"{platform.python_version()} at {redact(sys.executable)}",
        None if py >= MIN_PYTHON else "install Python >= 3.10")

    git_path = shutil.which("git")
    if git_path:
        add("PASS", "git", f"{first_line([git_path, '--version'])[1]} at {redact(git_path)}")
        top = git(REPO, "rev-parse", "--show-toplevel")
        add("PASS" if top else "FAIL", "repository", redact(top or REPO),
            None if top else "run the tools from a git checkout or worktree of the ClearCase repository")
    else:
        add("FAIL", "git", "not found on PATH", "install git (pacman -S git) and put it on PATH")

    node = which("node")
    if node:
        _, version = first_line([node, "--version"])
        parsed = parse_version(version)
        ok = bool(parsed) and parsed[:2] >= MIN_NODE
        add("PASS" if ok else "FAIL", "node", f"{version} at {redact(node)}",
            None if ok else f"install Node.js >= {MIN_NODE[0]} (pacman -S nodejs)")
    else:
        add("FAIL", "node", f"not found on PATH ({redact(os.environ.get('PATH', ''))})",
            "install Node.js >= 18 (pacman -S nodejs) and put it on PATH, or set CLEARCASE_NODE=/path/to/node; "
            "pstack check-plan.mjs needs it")

    for script in ["scripts/planning/check.py", "scripts/planning/generate.py"]:
        present = (REPO / script).is_file()
        add("PASS" if present else "FAIL", "planning", script, None if present else "check out the full repository")

    base = skills_dir(skills)
    lock = load_lock()
    if not base or not (base / "poteto-mode/SKILL.md").is_file():
        add("FAIL", "skills-dir", f"pstack bundle not found at {redact(base) if base else 'any default location'} (looked for poteto-mode/SKILL.md)",
            "install the pinned bundle into ~/.agents/skills (see Bootstrap in docs/agent-tooling.md) "
            "or set CLEARCASE_SKILLS_DIR / bootstrap --skills-dir DIR")
    else:
        add("PASS", "skills-dir", redact(base))
        for rel in lock["requiredFiles"]:
            present = (base / rel).is_file()
            add("PASS" if present else "FAIL", "skill-file", rel,
                None if present else "reinstall the pstack bundle; this file is required by the project tools")
        drift = []
        for name, pinned in sorted(lock["skills"].items()):
            path = base / name
            if not (path / "SKILL.md").is_file():
                add("FAIL", f"skill:{pinned['group']}", f"{name} missing",
                    f"install {name} into {redact(base)} from the pinned bundle")
                continue
            digest, count = tree_hash(path)
            if digest != pinned["sha256"]:
                drift.append(name)
                add("FAIL", f"skill:{pinned['group']}", f"{name} differs from the pin ({count} files, {digest[:12]})",
                    "review the installed change, then run scripts/agent-tools/bootstrap --relock and commit skills.lock.json")
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

    for name, purpose in [("bun", "pstack orch/watch-pr only; unused here"), ("gh", "pushing and PR checks"),
                          ("tmux", "headless worker sessions")]:
        info = tool_info(name)
        add("INFO", "optional", f"{name} {info['version'] or 'absent'} ({purpose})")
    add("DEFERRED", "app-browser", APP_DEFERRED)
    if (REPO / "package.json").exists():
        add("INFO", "app", "repository package.json present; app checks belong to GRS-10/GRS-12 commands")
    return rows


def cmd_doctor(args):
    rows = doctor_rows(args.skills_dir, args.receipts)
    for status, name, detail, fix in rows:
        print(f"{status:<8} {name:<14} {detail}")
        if fix:
            print(f"{'':<8} {'':<14} fix: {fix}")
    failed = [row for row in rows if row[0] == "FAIL"]
    passed = [row for row in rows if row[0] == "PASS"]
    deferred = [row[1] for row in rows if row[0] == "DEFERRED"]
    verdict = "FAIL" if failed else "PASS"
    print(f"doctor: {verdict}. {len(passed)} required checks passed, {len(failed)} failed. "
          f"Deferred, not required yet: {', '.join(deferred) or 'none'}.")
    return 1 if failed else 0


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
                "no pstack checkout supplied; pass --checkout DIR, a clone of the pinned upstream revision")
        checkout = Path(args.checkout).expanduser().resolve()
        command += ["--checkout", str(checkout)]
        if args.skills_dir:
            command += ["--skills-dir", str(Path(args.skills_dir).expanduser().resolve())]
        return command, ["python3", "git"], [LOCK_PATH, checkout / ".cursor-plugin/plugin.json"], None
    if name == "app":
        return ["app"], [], [], APP_DEFERRED
    raise SystemExit(f"unknown capability {name}")


CAPABILITIES = {
    "plan-graph": "python3 scripts/planning/check.py --require-linear-ids (graph, coverage, Linear ID map, generated files)",
    "linear-relations": "python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK",
    "plan-format": "node <skills>/poteto-mode/scripts/check-plan.mjs PLAN (pstack multi-phase plan structure)",
    "pstack-upstream": "installed pstack bundle and skills.lock.json against a checkout of the pinned revision (--checkout DIR)",
    "app": "deferred to GRS-12 (CC-03); always SKIPPED until the app and its verify skill exist",
}


def cmd_compare_upstream(args):
    """Run by verify pstack-upstream: check the pin's provenance, membership and content against a checkout."""
    lock, base, checkout = load_lock(), skills_dir(args.skills_dir), Path(args.checkout).resolve()
    pin = lock["provenance"]["pstack"]
    if not base:
        print("pstack-upstream: FAIL. pstack bundle not found; run scripts/agent-tools/doctor.")
        return 1
    problems = []
    head = git(checkout, "rev-parse", "HEAD")
    if head != pin["revision"]:
        problems.append(f"checkout is at {head or 'no git revision'}, the pin is {pin['revision']}; "
                        f"run git -C {redact(checkout)} checkout --detach {pin['revision']}")
    if git(checkout, "status", "--porcelain", "--", "skills", ".cursor-plugin"):
        problems.append("checkout has local changes under skills/ or .cursor-plugin/; use a clean checkout")
    plugin = json.loads((checkout / ".cursor-plugin/plugin.json").read_text())
    for field in ("version", "license"):
        if plugin.get(field) != pin[field]:
            problems.append(f"plugin.json {field} is {plugin.get(field)!r}, provenance.pstack records {pin[field]!r}")
    installed, absent = pstack_upstream(checkout, base)
    pinned = {name for name, row in lock["skills"].items() if row["group"] == "pstack"}
    relock = f"review it, then run scripts/agent-tools/bootstrap --relock --checkout {redact(checkout)}"
    for name in sorted(installed - pinned):
        group = lock["skills"].get(name, {}).get("group")
        problems.append(f"{name} is an installed upstream skill but is {f'pinned as {group}' if group else 'not pinned'}; {relock}")
    for name in sorted(pinned - installed):
        problems.append(f"{name} is pinned as pstack but is {'not installed' if name in absent else 'not in the checkout'}")
    if sorted(absent) != sorted(pin["notInstalled"]):
        problems.append(f"upstream skills not installed are {sorted(absent)}, provenance.pstack.notInstalled "
                        f"records {sorted(pin['notInstalled'])}")
    for name in sorted(pinned & installed):
        diff = upstream_diff(checkout / "skills" / name, base / name)
        problems += [f"{name}/{line}" for line in diff]
        if not diff and tree_hash(checkout / "skills" / name)[0] != lock["skills"][name]["sha256"]:
            problems.append(f"{name}: installed files match the checkout but not the pinned sha256; {relock}")
    for problem in problems:
        print(f"FAIL     {problem}")
    target = f"{pin['upstream']} at {pin['revision'][:12]} ({pin['version']}, {pin['license']})"
    if problems:
        print(f"pstack-upstream: FAIL. {len(problems)} problems against {target}.")
        return 1
    print(f"pstack-upstream: PASS. {len(pinned)} pinned pstack skills are byte-identical to {target}. "
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
            print(f"{name:<17} {'deferred ' if name == 'app' else 'available'} {text}")
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
                            receipts=args.receipts, base=args.base, root=args.root or REPO)


# Bootstrap ------------------------------------------------------------------

def cmd_bootstrap(args):
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
    if args.checkout and not args.relock:
        raise SystemExit("bootstrap: --checkout is only used with --relock")
    if args.relock:
        if not base:
            raise SystemExit("bootstrap --relock: pstack bundle not found")
        lock = load_lock()
        groups = {name: row["group"] for name, row in lock["skills"].items()}
        if args.checkout:
            checkout = Path(args.checkout).expanduser().resolve()
            installed, absent = pstack_upstream(checkout, base)
            if not installed:
                raise SystemExit(f"bootstrap --relock: no installed skill found under {redact(checkout)}/skills; "
                                 "pass the root of a pstack checkout")
            changed = [f"{name}/{line}" for name in sorted(installed)
                       for line in upstream_diff(checkout / "skills" / name, base / name)]
            if changed:
                raise SystemExit("bootstrap --relock: the installed bundle differs from the checkout, so it is not "
                                 "that revision:\n  " + "\n  ".join(changed))
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
            print(f"bootstrap: {len(installed)} pinned as pstack from {redact(checkout)} at {git(checkout, 'rev-parse', 'HEAD')}; "
                  f"upstream skills not installed: {', '.join(sorted(absent)) or 'none'}. Update provenance.pstack to match, "
                  "then run scripts/agent-tools/verify pstack-upstream --checkout DIR.")
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
        p.add_argument("--base", help="base ref recorded in receipts (default: origin/dev, then dev)")
        p.add_argument("--root", help="repository root to check (default: this checkout)")
        return p

    common(sub.add_parser("doctor")).set_defaults(func=cmd_doctor)
    boot = common(sub.add_parser("bootstrap"))
    mode = boot.add_mutually_exclusive_group()
    mode.add_argument("--relock", action="store_true")
    mode.add_argument("--remove", action="store_true")
    boot.add_argument("--checkout", help="with --relock: pin every installed skill of this pstack checkout as group pstack")
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
