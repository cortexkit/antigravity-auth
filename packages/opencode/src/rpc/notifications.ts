import type { OpenDialogPayload, RpcNotification } from './protocol'

const QUEUE_CAP = 100
const CONNECTION_TTL_MS = 3_000

let queue: RpcNotification[] = []
let nextId = 1
let lastDrainAtAny = 0
const lastDrainAtBySession = new Map<string, number>()

export function pushNotification(
  payload: OpenDialogPayload,
  sessionId?: string,
): void {
  queue.push({ id: nextId++, type: 'open-dialog', payload, sessionId })
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
}

export function drainNotifications(
  lastReceivedId = 0,
  sessionId?: string,
): RpcNotification[] {
  const now = Date.now()
  lastDrainAtAny = now
  if (sessionId !== undefined) lastDrainAtBySession.set(sessionId, now)

  if (lastReceivedId > 0) {
    queue = queue.filter((notification) => {
      if (notification.id > lastReceivedId) return true
      if (sessionId === undefined) return false
      return notification.sessionId !== sessionId
    })
  }

  return queue.filter(
    (notification) =>
      notification.id > lastReceivedId &&
      (sessionId === undefined ||
        notification.sessionId === undefined ||
        notification.sessionId === sessionId),
  )
}

export function isTuiConnected(sessionId?: string): boolean {
  const now = Date.now()
  if (sessionId !== undefined) {
    const lastDrainAt = lastDrainAtBySession.get(sessionId) ?? 0
    return lastDrainAt > 0 && now - lastDrainAt < CONNECTION_TTL_MS
  }
  return lastDrainAtAny > 0 && now - lastDrainAtAny < CONNECTION_TTL_MS
}

export function resetNotificationsForTest(): void {
  queue = []
  nextId = 1
  lastDrainAtAny = 0
  lastDrainAtBySession.clear()
}
