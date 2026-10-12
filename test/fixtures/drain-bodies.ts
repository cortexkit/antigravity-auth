export async function drainBodies(
  releases: Array<() => void>,
  bodies: Iterable<Promise<unknown>>,
  cleanup: () => unknown,
  operations: Iterable<Promise<unknown>> = [],
): Promise<void> {
  for (const release of releases) release()
  // A resource call returning is not the end of a test: its body can still
  // read persisted state. Keep resources alive through those final reads.
  await Promise.allSettled(bodies)
  await Promise.allSettled(operations)
  await cleanup()
}
