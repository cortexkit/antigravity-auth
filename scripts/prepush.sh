#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
phase=preflight
step=arguments
started=$SECONDS

fail() {
  echo "PREPUSH_FAILED phase=$phase step=$step: $*" >&2
  exit 1
}

run_step() {
  step=$1
  shift
  local code=0
  echo "PREPUSH_STEP phase=$phase step=$step command=$*"
  "$@" || code=$?
  echo "PREPUSH_EXIT phase=$phase step=$step exit=$code"
  if (( code != 0 )); then
    fail "exit=$code elapsed=$((SECONDS - started))s"
  fi
}

clean_tree() {
  local dirty
  dirty=$(git status --porcelain --untracked-files=no)
  [[ -z "$dirty" ]] || fail "dirty tracked tree; commit or restore changes first:
$dirty"
}

same_commit() {
  clean_tree
  [[ $(git rev-parse HEAD) == "$commit" ]] || fail 'HEAD changed during the gate'
}

ci_only() {
  echo 'Covered by GitHub CI only: OpenCode 2 Docker smoke (MOTOR has no Docker).'
  echo 'Covered by GitHub CI only: embed.clean_input Docker scratch-image export (MOTOR has no Docker; CI sets ANTIGRAVITY_TEST_REQUIRE_DOCKER=1).'
  echo 'Covered by GitHub CI only: four-runtime RPC matrix (Node 20.0.0, Node 24.16.0, Bun 1.3.14, Bun 1.4.2 are not provisioned together by this job).'
  echo 'Covered by GitHub CI only: Windows vault, account migration and Pi privacy jobs (windows-latest and windows-2022).'
}

prepare_full_dependencies() {
  run_step install bun install --frozen-lockfile
  run_step embed-input bun packages/opencode/scripts/embed-common-auth.ts --check
  run_step tui-compiler bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
  if [[ -d node_modules ]]; then
    # Preinstalled dependencies may belong to the build server, not the job user.
    # Keep that input intact and give the job an owned copy before tightening it.
    if [[ ! -O node_modules ]]; then
      local dependencies
      dependencies=$(mktemp -d "$PWD/.prepush-dependencies.XXXXXX")
      run_step dependency-copy cp -R --no-preserve=ownership node_modules "$dependencies/owned"
      run_step dependency-input mv node_modules "$dependencies/input"
      run_step dependency-owned mv "$dependencies/owned" node_modules
    fi
    # Enrollment fixtures refuse group- or world-writable dependency ancestors.
    run_step dependency-permissions chmod go-w node_modules
  fi
  if [[ -d tools/common-auth-build/node_modules ]]; then
    # CI's fresh compiler install fills Bun's cache (ci.yml:38). The test supervisor
    # clears cache overrides, so its executable-relative default must be primed too.
    # An owned Bun prefix avoids the build server's read-only installation prefix.
    local bun_executable runtime_root compiler_cache
    bun_executable=$(bun -e 'process.stdout.write(process.execPath)')
    runtime_root="$PWD/node_modules/.cache/prepush-bun"
    compiler_cache="$runtime_root/install/cache"
    run_step runtime-directories mkdir -p "$runtime_root/bin" "$compiler_cache"
    if [[ "$bun_executable" != "$runtime_root/bin/bun" ]]; then
      run_step runtime-copy cp "$bun_executable" "$runtime_root/bin/bun"
    fi
    # Staged-file hooks use the standard bunx alias alongside the Bun executable.
    run_step runtime-bunx ln -sf bun "$runtime_root/bin/bunx"
    export PATH="$runtime_root/bin:$PATH"
    run_step compiler-cache env BUN_INSTALL_CACHE_DIR="$compiler_cache" "$runtime_root/bin/bun" install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts --force --cache-dir "$compiler_cache"
  fi
}

mode=${1:-}
case "$mode" in
  ''|--fast) [[ $# -le 1 ]] || fail 'usage: bun run prepush [--fast]' ;;
  --full-here) [[ $# -le 2 ]] || fail 'usage: bash scripts/prepush.sh --full-here [commit]' ;;
  *) fail 'usage: bun run prepush [--fast] or bash scripts/prepush.sh --full-here' ;;
esac

step=clean-tree
clean_tree
commit=$(git rev-parse HEAD)
step=bun-version
[[ $(bun --version) == 1.4.2 ]] || fail 'requires Bun 1.4.2 exactly'

ci_only
if [[ "$mode" == --full-here ]]; then
  phase=full
  step=linux-identity
  [[ $(uname -s) == Linux ]] || fail 'full phase requires MOTOR Linux'
  [[ "$commit" == "${2:-$commit}" ]] || fail 'MOTOR checkout does not match submitted commit'
  prepare_full_dependencies
  run_step embed bun run embed:check
  # The core build deletes dist; keep every dependent step sequential.
  run_step core-build bun run --cwd packages/core build
  run_step typecheck bun run typecheck
  run_step build bun run build
  run_step tui-smoke bun run --cwd packages/opencode smoke:tui
  run_step test bun run test
  run_step test-e2e bun run test:e2e
  step=final-identity
  same_commit
  echo "PREPUSH_FULL_OK $commit elapsed=$((SECONDS - started))s"
  echo "PREPUSH_OK $commit"
  exit 0
fi

phase=fast
step=cortexkit-tracking
tracked_ignored=$(git ls-files -ci --exclude-standard -- .cortexkit)
[[ -z "$tracked_ignored" ]] || fail "ignored .cortexkit files are tracked:
$tracked_ignored"
echo 'PREPUSH_EXIT phase=fast step=cortexkit-tracking exit=0'
# Real frozen installs: they refuse lockfile drift as the dry runs did, and
# give a fresh checkout the dependencies the embed check, formatter and
# linter need. CI checks the embedding input before every compiler install.
run_step lockfile bun install --frozen-lockfile
run_step embed-input bun packages/opencode/scripts/embed-common-auth.ts --check
run_step compiler-lockfile bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
run_step embed bun run embed:check
run_step format bun run format:check
# Both root scripts already include lint:native-inert.
run_step lint bun run lint
run_step disk-test-list bun test --isolate ./test/test-root.test.ts
run_step import-graph bun test --isolate ./packages/opencode/src/plugin/shared/import-graph.test.ts
run_step sync-spawn bun test --isolate ./test/sync-spawn-guard.test.ts
step=final-identity
same_commit
echo "PREPUSH_FAST_OK $commit elapsed=$((SECONDS - started))s"
if [[ "$mode" == --fast ]]; then
  echo 'Full Linux phase not run (--fast); this is not a complete pre-push pass.'
  exit 0
fi

phase=motor
step=submit
command -v ck >/dev/null || fail 'ck is required to submit the MOTOR Linux job'
# Use the same qualified 16-vCPU MOTOR placement as test:native-inert.
# Network access is needed for the frozen installs, not for a different runner.
run_step linux-job ck motor run --vcpus 16 --net --cwd "$PWD" -- bash scripts/prepush.sh --full-here "$commit"
step=final-identity
same_commit
echo "PREPUSH_OK $commit elapsed=$((SECONDS - started))s"
