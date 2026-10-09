# Sourced by every agent-tools entry point. Uses bash builtins only until it
# has confirmed python3 exists, so a broken PATH still gets an actionable error.

TOOLS_DIR=$(cd "${BASH_SOURCE[0]%/*}" && pwd)

if [[ $OSTYPE != linux* ]]; then
	echo "agent-tools: unsupported OS '$OSTYPE'. Supported: Linux (Arch, CachyOS) with bash >= 4.4. See docs/agent-tooling.md." >&2
	exit 2
fi
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
	echo "agent-tools: bash $BASH_VERSION is too old; bash >= 4.4 is required." >&2
	exit 2
fi

PYTHON=${CLEARCASE_PYTHON:-$(command -v python3 || true)}
if [[ -z $PYTHON || ! -x $PYTHON ]]; then
	echo "agent-tools: FAIL python3 not found (PATH=$PATH)." >&2
	echo "  fix: install Python >= 3.10 (pacman -S python) and put it on PATH, e.g. PATH=/usr/local/bin:/usr/bin:/bin, or set CLEARCASE_PYTHON=/path/to/python3." >&2
	exit 2
fi

export CLEARCASE_BASH_VERSION=$BASH_VERSION

run_agent_tools() {
	exec "$PYTHON" -I -B "$TOOLS_DIR/agent_tools.py" "$@"
}
