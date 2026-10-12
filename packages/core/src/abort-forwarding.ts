/** Forward one signal's reason without changing it; the owner chooses when to detach. */
export function forwardAbort(
  source: AbortSignal | null | undefined,
  target: AbortController,
): () => void {
  if (!source || target.signal.aborted) return () => {}
  const onAbort = () => target.abort(source.reason)
  if (source.aborted) {
    onAbort()
    return () => {}
  }
  source.addEventListener('abort', onAbort, { once: true })
  let detached = false
  return () => {
    if (detached) return
    detached = true
    source.removeEventListener('abort', onAbort)
  }
}
