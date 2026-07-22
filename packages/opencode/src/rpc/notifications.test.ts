import { describe, expect, it } from 'bun:test'

import { createNotificationQueue } from './notifications'
import type { OpenDialogPayload } from './protocol'

function payload(text: string): OpenDialogPayload {
  return {
    command: 'antigravity-quota',
    text,
    knobs: {},
  }
}

describe('notification queue', () => {
  it('assigns monotonic IDs and drains notifications in insertion order', () => {
    const queue = createNotificationQueue()
    queue.pushNotification(payload('first'))
    queue.pushNotification(payload('second'))

    expect(
      queue.drainNotifications(0).map(({ id, text }) => ({ id, text })),
    ).toEqual([
      { id: 1, text: 'first' },
      { id: 2, text: 'second' },
    ])
    expect(queue.drainNotifications(1).map(({ id }) => id)).toEqual([2])
  })

  it('evicts the oldest notifications after the 100-entry cap', () => {
    const queue = createNotificationQueue()
    for (let index = 1; index <= 105; index += 1) {
      queue.pushNotification(payload(`notification-${index}`))
    }

    const drained = queue.drainNotifications(0)
    expect(drained).toHaveLength(100)
    expect(drained[0]?.id).toBe(6)
    expect(drained.at(-1)?.id).toBe(105)
  })

  it('isolates targeted notifications while retaining broadcasts', () => {
    const queue = createNotificationQueue()
    queue.pushNotification(payload('broadcast'))
    queue.pushNotification(payload('session-a'), 'a')
    queue.pushNotification(payload('session-b'), 'b')

    expect(queue.drainNotifications(0, 'a').map(({ text }) => text)).toEqual([
      'broadcast',
      'session-a',
    ])
    expect(queue.drainNotifications(0, 'b').map(({ text }) => text)).toEqual([
      'broadcast',
      'session-b',
    ])
    expect(queue.drainNotifications(0).map(({ text }) => text)).toEqual([
      'broadcast',
    ])
  })

  it('reports a TUI connected for five seconds after that session drains', () => {
    let now = 10_000
    const queue = createNotificationQueue({ now: () => now })

    expect(queue.isTuiConnected('session-a')).toBe(false)
    queue.drainNotifications(0, 'session-a')
    expect(queue.isTuiConnected('session-a')).toBe(true)
    expect(queue.isTuiConnected('session-b')).toBe(false)

    now += 5_000
    expect(queue.isTuiConnected('session-a')).toBe(true)
    now += 1
    expect(queue.isTuiConnected('session-a')).toBe(false)
  })
})
