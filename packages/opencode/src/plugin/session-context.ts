import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  AgyRequestSessionStore,
  type AgyRequestScope,
  type AgyRequestSessionContext,
  type AgyRequestSessionStoreOptions,
} from "./agy-request-metadata"

const FALLBACK_SESSION_KEY = "__default__"

export interface OpenCodeSessionIdentity {
  sessionId: string | null
  parentSessionId: string | null
}

export type AgySessionRegistryOptions = AgyRequestSessionStoreOptions

export function extractOpenCodeSessionIdentity(headers?: HeadersInit): OpenCodeSessionIdentity {
  const normalized = new Headers(headers)
  return {
    sessionId: normalized.get("x-session-affinity") ?? normalized.get("x-session-id"),
    parentSessionId: normalized.get("x-parent-session-id"),
  }
}

export class AgySessionRegistry {
  private readonly requestSessions: AgyRequestSessionStore
  private readonly parentSessionIds = new Map<string, string | null>()

  constructor(directory: string, options: AgySessionRegistryOptions = {}) {
    const workspaceUri = directory ? pathToFileURL(resolve(directory)).href : ""
    this.requestSessions = new AgyRequestSessionStore(workspaceUri, options)
  }

  getOrCreate(identity: OpenCodeSessionIdentity): AgyRequestSessionContext {
    const key = identity.sessionId ?? FALLBACK_SESSION_KEY
    const request = this.requestSessions.getOrCreate(key)
    this.recordParent(key, identity.parentSessionId)
    this.pruneParentRelationships()
    return request
  }

  beginRequest(identity: OpenCodeSessionIdentity): AgyRequestScope {
    const key = identity.sessionId ?? FALLBACK_SESSION_KEY
    const scope = this.requestSessions.beginRequest(key)
    this.recordParent(key, identity.parentSessionId)
    this.pruneParentRelationships()
    return scope
  }

  register(sessionId: string, parentSessionId: string | null = null): void {
    this.getOrCreate({ sessionId, parentSessionId })
  }

  getParentSessionId(sessionId: string): string | null {
    if (!this.requestSessions.has(sessionId)) {
      this.parentSessionIds.delete(sessionId)
      return null
    }
    return this.parentSessionIds.get(sessionId) ?? null
  }

  delete(sessionId: string): void {
    this.requestSessions.delete(sessionId)
    this.parentSessionIds.delete(sessionId)
  }

  get size(): number {
    return this.requestSessions.size
  }

  private recordParent(key: string, parentSessionId: string | null): void {
    if (parentSessionId || !this.parentSessionIds.has(key)) {
      this.parentSessionIds.set(key, parentSessionId)
    }
  }

  private pruneParentRelationships(): void {
    for (const sessionId of this.parentSessionIds.keys()) {
      if (!this.requestSessions.has(sessionId)) {
        this.parentSessionIds.delete(sessionId)
      }
    }
  }
}
