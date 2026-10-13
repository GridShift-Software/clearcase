#!/bin/bash
# Installs Chrome for Testing 148.0.7778.96, full Chrome and the headless shell, in Playwright's cache layout under
# $HOME, where the browser unit tests (tests/case-package/render.test.ts, tests/e2e/pilot/lib/cdp.mjs) look for it.
# The zips are kept and their hashes checked on every run, so a persistent runner downloads them once. A tree is
# unpacked again only when its .zip-sha256 stamp, written last, does not name the checked zip.
set -euo pipefail
base=https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.96/linux64
zips=$HOME/.cache/clearcase-ci/chrome-for-testing-148.0.7778.96
mkdir -p "$zips"
fetch() { # zip name, its sha256, Playwright cache directory
  local zip=$zips/$1.zip
  if ! echo "$2  $zip" | sha256sum -c --status 2>/dev/null; then
    curl -fsSLo "$zip.part" "$base/$1.zip"
    echo "$2  $zip.part" | sha256sum -c -
    mv "$zip.part" "$zip"
  fi
  local dir=$HOME/.cache/ms-playwright/$3
  [[ $(cat "$dir/.zip-sha256" 2>/dev/null) == "$2" ]] && return
  rm -rf "$dir"
  mkdir -p "$dir"
  unzip -q "$zip" -d "$dir"
  echo "$2" >"$dir/.zip-sha256"
}
fetch chrome-linux64 e58a0612f6156ad287ff392c681f6e1154d0c938feccf631d0c5d7abf3bbf81a chromium-1223
fetch chrome-headless-shell-linux64 88817c574c1838a39f88fda0bbd043b4481fd385fb10e92c323e230844d636ce chromium_headless_shell-1223
