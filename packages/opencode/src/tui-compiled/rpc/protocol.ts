export type CommandModalName =
  | 'antigravity-quota'
  | 'antigravity-account'
  | 'antigravity-routing'
  | 'antigravity-killswitch'
  | 'antigravity-dump'
  | 'antigravity-logging'

export interface OpenDialogPayload {
  command: CommandModalName
  text: string
  knobs: Record<string, unknown>
}

export interface RpcNotification {
  id: number
  type: 'open-dialog'
  payload: OpenDialogPayload
  sessionId?: string
}

export interface ApplyRequest {
  command: CommandModalName
  arguments: string
  sessionId?: string
}

export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}
