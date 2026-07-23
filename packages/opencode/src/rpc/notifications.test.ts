import { beforeEach, describe, expect, it, spyOn } from 'bun:test'

import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
  resetNotificationsForTest,
} from './notifications'
import type { OpenDialogPayload } from './protocol'

function payload(text: string): OpenDialogPayload {
  return {
    command: 'antigravity-quota',
    text,
    knobs: {},
  }
}

describe('notification queue', () => {
  beforeEach(() => {
    resetNotificationsForTest()
  })

  it('wraps payloads in typed envelopes with monotonic IDs', () => {
    pushNotification(payload('first'))
    pushNotification(payload('second'))

    expect(drainNotifications(0)).toEqual([
      {
        id: 1,
        type: 'open-dialog',
        payload: payload('first'),
        sessionId: undefined,
      },
      {
        id: 2,
        type: 'open-dialog',
        payload: payload('second'),
        sessionId: undefined,
      },
    ])
    expect(drainNotifications(1).map(({ id }) => id)).toEqual([2])
  })

  it('evicts the oldest notifications after the 100-entry cap', () => {
    for (let index = 1; index <= 105; index += 1) {
      pushNotification(payload(`notification-${index}`))
    }

    const drained = drainNotifications(0)
    expect(drained).toHaveLength(100)
    expect(drained[0]?.id).toBe(6)
    expect(drained.at(-1)?.id).toBe(105)
  })

  it('isolates targeted notifications while retaining broadcasts for other sessions', () => {
    pushNotification(payload('broadcast'))
    pushNotification(payload('session-a'), 'a')
    pushNotification(payload('session-b'), 'b')

    expect(
      drainNotifications(0, 'a').map(({ payload: item }) => item.text),
    ).toEqual(['broadcast', 'session-a'])

    drainNotifications(2, 'a')

    expect(
      drainNotifications(0, 'b').map(({ payload: item }) => item.text),
    ).toEqual(['broadcast', 'session-b'])
    expect(drainNotifications(0).map(({ payload: item }) => item.text)).toEqual(
      ['broadcast', 'session-b'],
    )
  })

  it('reports a TUI connected within the 3000ms drain window', () => {
    const now = spyOn(Date, 'now')
    now.mockReturnValue(10_000)

    expect(isTuiConnected('session-a')).toBe(false)
    drainNotifications(0, 'session-a')
    expect(isTuiConnected('session-a')).toBe(true)
    expect(isTuiConnected('session-b')).toBe(false)
    expect(isTuiConnected()).toBe(true)

    now.mockReturnValue(12_999)
    expect(isTuiConnected('session-a')).toBe(true)
    now.mockReturnValue(13_000)
    expect(isTuiConnected('session-a')).toBe(false)

    now.mockRestore()
  })
})
