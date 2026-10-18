import { expect, it } from 'bun:test'
import { createAfterHandoff, publishResponse } from './after-handoff.ts'

it('tracks dormant work and acknowledges it once after public availability', async () => {
  const work = new Set<Promise<void>>()
  const gate = Promise.withResolvers<void>()
  const events: string[] = []
  const handoff = createAfterHandoff(work, [], () => {
    throw new Error('unexpected failure')
  })
  handoff.register(async () => {
    events.push('work')
    await gate.promise
  })
  expect(work.size).toBe(1)
  expect(events).toEqual([])
  const response = await publishResponse(async (register) => {
    register(() => {
      handoff.acknowledge()
      handoff.acknowledge()
    })
    return new Response(null, { status: 204 })
  }).then((response) => {
    events.push('public')
    return response
  })
  expect(response.status).toBe(204)
  expect(events).toEqual(['public', 'work'])
  expect(work.size).toBe(1)
  const completion = [...work]
  gate.resolve()
  await Promise.all(completion)
  expect(work.size).toBe(0)
})

it('cancels a dormant closure and rechecks abort after acknowledgement', async () => {
  for (const acknowledged of [false, true]) {
    const controller = new AbortController()
    const work = new Set<Promise<void>>()
    let entries = 0
    const handoff = createAfterHandoff(work, [controller.signal], () => {})
    handoff.register(async () => {
      entries++
    })
    if (acknowledged) handoff.acknowledge()
    controller.abort()
    handoff.acknowledge()
    await Promise.resolve()
    expect(entries).toBe(0)
    expect(work.size).toBe(0)
  }
})

it('running cancellation remains joined until its continuation settles', async () => {
  const work = new Set<Promise<void>>()
  const entered = Promise.withResolvers<AbortSignal>()
  const gate = Promise.withResolvers<void>()
  const handoff = createAfterHandoff(work, [], () => {})
  handoff.register(async (signal) => {
    entered.resolve(signal)
    await gate.promise
  })
  handoff.acknowledge()
  const signal = await entered.promise
  handoff.cancel()
  expect(signal.aborted).toBe(true)
  expect(work.size).toBe(1)
  const pending = [...work]
  gate.resolve()
  await Promise.all(pending)
  expect(work.size).toBe(0)
})
