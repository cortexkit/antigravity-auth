import { describe, expect, it } from "vitest"

import {
  buildAuthFromStoredAccount,
  detectAuthStorageDrift,
  selectRestorableAccount,
} from "./auth-drift.ts"
import type { AccountStorageV4 } from "./storage.ts"
import type { AuthDetails } from "./types.ts"

function storage(overrides: Partial<AccountStorageV4> = {}): AccountStorageV4 {
  return {
    version: 4,
    activeIndex: 0,
    accounts: [
      {
        email: "active@example.com",
        refreshToken: "active-refresh",
        projectId: "project-a",
        managedProjectId: "managed-a",
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
      },
      {
        email: "backup@example.com",
        refreshToken: "backup-refresh",
        addedAt: 3,
        lastUsed: 4,
        enabled: true,
      },
    ],
    ...overrides,
  }
}

describe("selectRestorableAccount", () => {
  it("selects the active enabled stored account", () => {
    expect(selectRestorableAccount(storage())?.refreshToken).toBe("active-refresh")
  })

  it("falls back to the first enabled account when active index is invalid", () => {
    expect(selectRestorableAccount(storage({ activeIndex: 99 }))?.refreshToken).toBe("active-refresh")
  })

  it("skips disabled accounts", () => {
    const result = selectRestorableAccount(storage({
      activeIndex: 0,
      accounts: [
        {
          email: "disabled@example.com",
          refreshToken: "disabled-refresh",
          addedAt: 1,
          lastUsed: 1,
          enabled: false,
        },
        {
          email: "enabled@example.com",
          refreshToken: "enabled-refresh",
          addedAt: 2,
          lastUsed: 2,
          enabled: true,
        },
      ],
    }))

    expect(result?.refreshToken).toBe("enabled-refresh")
  })

  it("returns undefined when all accounts are disabled", () => {
    expect(selectRestorableAccount(storage({
      accounts: [
        {
          refreshToken: "disabled-refresh",
          addedAt: 1,
          lastUsed: 1,
          enabled: false,
        },
      ],
    }))).toBeUndefined()
  })
})

describe("buildAuthFromStoredAccount", () => {
  it("creates OpenCode OAuth auth from a stored account", () => {
    const account = storage().accounts[0]!

    expect(buildAuthFromStoredAccount(account)).toEqual({
      type: "oauth",
      refresh: "active-refresh|project-a|managed-a",
      access: "",
      expires: 0,
    })
  })
})

describe("detectAuthStorageDrift", () => {
  it("reports missing OpenCode auth as restorable when account storage is valid", () => {
    const report = detectAuthStorageDrift(undefined, storage())

    expect(report.status).toBe("restorable")
    expect(report.reason).toBe("missing-opencode-auth")
    expect(report.account?.email).toBe("active@example.com")
  })

  it("reports refresh token mismatch between OpenCode auth and account storage", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "unknown-refresh|project-z",
    }

    expect(detectAuthStorageDrift(auth, storage())).toMatchObject({
      status: "drifted",
      reason: "refresh-token-not-in-storage",
    })
  })

  it("reports healthy when OpenCode auth refresh token exists in account storage", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "backup-refresh|project-z",
    }

    expect(detectAuthStorageDrift(auth, storage())).toMatchObject({
      status: "healthy",
      reason: "auth-matches-storage",
    })
  })
})
