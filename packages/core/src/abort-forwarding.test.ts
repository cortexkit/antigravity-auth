import { describe, expect, it, spyOn } from 'bun:test'

import { forwardAbort } from './abort-forwarding.ts'

describe('forwardAbort', () => {
  it('forwards a pre-abort without registering a listener', () => {
    const caller = new AbortController()
    const target = new AbortController()
    const reason = { message: 'already canceled' }
    caller.abort(reason)
    const add = spyOn(caller.signal, 'addEventListener')
    const detach = forwardAbort(caller.signal, target)
    expect(target.signal.aborted).toBe(true)
    expect(target.signal.reason).toBe(reason)
    expect(add).not.toHaveBeenCalled()
    detach()
    add.mockRestore()
  })

  it('preserves the first reason and leaves the source untouched', () => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const target = new AbortController()
    const callerReason = new Error('caller')
    const detachCaller = forwardAbort(caller.signal, target)
    const detachDeadline = forwardAbort(deadline.signal, target)
    caller.abort(callerReason)
    deadline.abort(new Error('deadline'))
    expect(target.signal.reason).toBe(callerReason)
    expect(caller.signal.reason).toBe(callerReason)
    detachCaller()
    detachDeadline()
  })

  it('detaches the exact listener once and prevents later forwarding', () => {
    const caller = new AbortController()
    const target = new AbortController()
    const add = spyOn(caller.signal, 'addEventListener')
    const remove = spyOn(caller.signal, 'removeEventListener')
    const detach = forwardAbort(caller.signal, target)
    expect(add).toHaveBeenCalledTimes(1)
    const listener = add.mock.calls[0]![1]
    detach()
    detach()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', listener)
    caller.abort(new Error('too late'))
    expect(target.signal.aborted).toBe(false)
    add.mockRestore()
    remove.mockRestore()
  })
})
