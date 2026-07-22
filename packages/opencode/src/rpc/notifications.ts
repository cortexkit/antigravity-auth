import type { OpenDialogPayload, RpcNotification } from './protocol'

const MAX_NOTIFICATIONS = 100
const CONNECTION_TTL_MS = 5_000
const GLOBAL_SESSION = ''

export interface NotificationQueueOptions {
  now?: () => number
}

export interface NotificationQueue {
  pushNotification(payload: OpenDialogPayload, sessionId?: string): number
  drainNotifications(
    lastReceivedId: number,
    sessionId?: string,
  ): RpcNotification[]
  isTuiConnected(sessionId?: string): boolean
}

export function createNotificationQueue(
  options: NotificationQueueOptions = {},
): NotificationQueue {
  const now = options.now ?? Date.now
  const notifications: RpcNotification[] = []
  const lastDrainBySession = new Map<string, number>()
  let nextId = 1

  return {
    pushNotification(payload, sessionId) {
      const notification: RpcNotification = {
        ...payload,
        id: nextId,
        ...(sessionId === undefined ? {} : { sessionId }),
      }
      nextId += 1
      notifications.push(notification)
      if (notifications.length > MAX_NOTIFICATIONS) {
        notifications.splice(0, notifications.length - MAX_NOTIFICATIONS)
      }
      return notification.id
    },
    drainNotifications(lastReceivedId, sessionId) {
      lastDrainBySession.set(sessionId ?? GLOBAL_SESSION, now())
      return notifications.filter(
        (notification) =>
          notification.id > lastReceivedId &&
          (notification.sessionId === undefined ||
            notification.sessionId === sessionId),
      )
    },
    isTuiConnected(sessionId) {
      const lastDrain = lastDrainBySession.get(sessionId ?? GLOBAL_SESSION)
      return lastDrain !== undefined && now() - lastDrain <= CONNECTION_TTL_MS
    },
  }
}

const defaultQueue = createNotificationQueue()

export const pushNotification = defaultQueue.pushNotification
export const drainNotifications = defaultQueue.drainNotifications
export const isTuiConnected = defaultQueue.isTuiConnected
