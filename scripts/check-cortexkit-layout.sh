#!/usr/bin/env bash
# Nothing under .cortexkit/ may be tracked except the allowed folders and files.
#
# The fleet layout keeps internal material (design notes, investigations, tool state)
# under .cortexkit/, ignored by git, and tracks only release-notes/, skills/, rules/,
# WORKER.md and project settings files (`.cortexkit/<module>.jsonc`, which the daemon
# reads as project settings) there. The check lists every tracked path under .cortexkit/ and refuses any
# outside that allowlist. It does not rely on the ignore rules alone: asking git only for
# tracked files that are also ignored (`ls-files -ci`) misses a private path that a stray
# `!` line in some .gitignore un-ignores, since that path is tracked but no longer ignored.
#
# The ignore block still matters, because it keeps internal files from being added by
# accident. So the check also confirms the block works: an internal path must be ignored
# and an allowed one must not be. If either control fails, or git can't list the tracked
# files, the checker reports itself BLIND and exits 2 rather than passing.
#
# Exit 0 clean, 1 a disallowed file is tracked, 2 the ignore rules don't work.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

if ! git check-ignore -q --no-index .cortexkit/internal-docs/designs/control.md; then
  echo "BLIND: .cortexkit/internal-docs/ is not ignored; the .cortexkit block is missing from .gitignore" >&2
  exit 2
fi
if git check-ignore -q --no-index .cortexkit/release-notes/control.md; then
  echo "BLIND: .cortexkit/release-notes/ is ignored; the block's allow lines are missing" >&2
  exit 2
fi

if ! all="$(git ls-files -- .cortexkit)"; then
  echo "BLIND: git ls-files failed, so the tracked files under .cortexkit/ are unknown" >&2
  exit 2
fi
tracked="$(printf '%s\n' "$all" | grep -vE '^\.cortexkit/(release-notes/|skills/|rules/|WORKER\.md$|[a-z0-9-]+\.jsonc$)' | grep -v '^$')"
if [ -n "$tracked" ]; then
  echo "tracked files under .cortexkit/ outside release-notes/, skills/, rules/, WORKER.md and <module>.jsonc:" >&2
  printf '%s\n' "$tracked" | sed 's/^/  /' >&2
  echo "move them to .cortexkit/internal-docs/ (or remove them) and 'git rm --cached' them" >&2
  exit 1
fi
echo "controls hold; no disallowed file is tracked under .cortexkit/"
