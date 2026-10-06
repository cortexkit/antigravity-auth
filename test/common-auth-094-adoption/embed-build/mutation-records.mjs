export const embedMutationCases = Object.freeze([
  'embed.integrity',
  'embed.inventory',
  'embed.regeneration',
  'embed.attribution',
  'embed.archive_refusals',
  'embed.clean_input',
  'build.repo_hygiene',
])
export const pathMutationCases = Object.freeze([
  'build.map_source_alias',
  'build.output_ancestor_alias',
  'build.output_source_alias',
  'build.lexical_path_refusals',
  'build.symlink_root_equivalence',
])

export function classifyMutationResult(result, expectedRed, inventory) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  // Bun emits records at the start of a line. Source excerpts and diagnostic prose
  // can contain identical markers, but are not evidence that a test executed.
  const records = [
    ...output.matchAll(
      /^\((pass|fail)\) ([^\r\n]+?)(?: \[\d+(?:\.\d+)?(?:ms|s)\])?\r?$/gm,
    ),
  ]
  const failures = records
    .filter((record) => record[1] === 'fail')
    .map((record) => record[2])
  const passes = records
    .filter((record) => record[1] === 'pass')
    .map((record) => record[2])
  const distinct = (names) => new Set(names).size === names.length
  const sameNames = (left, right) =>
    distinct(left) &&
    left.length === right.length &&
    left.every((name) => right.includes(name))
  const validInventory =
    inventory.length > 0 &&
    distinct(inventory) &&
    inventory.includes(expectedRed)
  const reporterError =
    /^# Unhandled error between tests\r?$|^\s*[1-9]\d* errors?\s*\r?$/m.test(
      output,
    )
  const reporterTimeout =
    /^\s*\^ (?:a (?:beforeEach\/afterEach|beforeAll\/afterAll) hook timed out for this test\.|this test timed out(?: after [^\r\n]+)?)\r?$/m.test(
      output,
    )
  const completed =
    result.error == null &&
    result.signal === null &&
    !reporterError &&
    !reporterTimeout
  const unaffected = inventory.filter((name) => name !== expectedRed)
  let outcome = 'not_reached'
  if (result.signal || result.error?.code === 'ETIMEDOUT') outcome = 'hung'
  else if (
    completed &&
    validInventory &&
    result.status === 1 &&
    failures.length === 1 &&
    failures[0] === expectedRed &&
    sameNames(passes, unaffected)
  )
    outcome = 'reddened'
  else if (
    completed &&
    validInventory &&
    result.status === 0 &&
    failures.length === 0 &&
    sameNames(passes, inventory)
  )
    outcome = 'undefended'
  return { failures, passes, outcome }
}
