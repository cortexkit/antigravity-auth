import { describe, expect, it } from "vitest"

import { createAuthDoctorReport, formatAuthDoctorReport } from "./auth-doctor.ts"
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
        addedAt: 1,
        lastUsed: 2,
        enabled: true,
      },
    ],
    ...overrides,
  }
}

describe("createAuthDoctorReport", () => {
  it("reports missing OpenCode auth as repairable when account storage is valid", () => {
    const report = createAuthDoctorReport({ auth: undefined, storage: storage() })

    expect(report.status).toBe("repairable")
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "missing-opencode-auth",
      severity: "error",
      repair: "restore-opencode-auth",
    }))
  })

  it("reports refresh-token drift as repairable", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "unknown-refresh|project-z",
    }

    const report = createAuthDoctorReport({ auth, storage: storage() })

    expect(report.status).toBe("repairable")
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "refresh-token-not-in-storage",
      repair: "restore-opencode-auth",
    }))
  })

  it("reports invalid active index as repairable", () => {
    const report = createAuthDoctorReport({ auth: undefined, storage: storage({ activeIndex: 9 }) })

    expect(report.status).toBe("repairable")
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "active-index-out-of-range",
      repair: "clamp-active-index",
    }))
  })

  it("reports disabled active account as repairable", () => {
    const report = createAuthDoctorReport({
      auth: undefined,
      storage: storage({
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
      }),
    })

    expect(report.status).toBe("repairable")
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "active-account-disabled",
      repair: "select-enabled-account",
    }))
  })

  it("reports verification-required accounts as warnings", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "active-refresh|project-a",
    }
    const report = createAuthDoctorReport({
      auth,
      storage: storage({
        accounts: [
          {
            email: "active@example.com",
            refreshToken: "active-refresh",
            addedAt: 1,
            lastUsed: 2,
            enabled: true,
            verificationRequired: true,
            verificationRequiredReason: "Google verification required",
          },
        ],
      }),
    })

    expect(report.status).toBe("warning")
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "verification-required",
      severity: "warning",
    }))
  })

  it("reports explicitly ineligible accounts with a recheck repair", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "active-refresh|project-a",
    }
    const report = createAuthDoctorReport({
      auth,
      storage: storage({
        accounts: [
          {
            email: "blocked@example.com",
            refreshToken: "active-refresh",
            addedAt: 1,
            lastUsed: 2,
            enabled: false,
            accountIneligible: true,
            accountIneligibleReason: "ACCOUNT_INELIGIBLE",
            eligibilityStateUpdatedAt: 100,
          },
        ],
      }),
    })

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "account-ineligible",
      severity: "warning",
      repair: "verify-account",
      accountEmail: "blocked@example.com",
    }))
  })

  it("reports healthy auth and storage", () => {
    const auth: AuthDetails = {
      type: "oauth",
      refresh: "active-refresh|project-a",
    }

    expect(createAuthDoctorReport({ auth, storage: storage() })).toMatchObject({
      status: "ok",
      summary: "OpenCode auth and Antigravity account storage are in sync.",
    })
  })
})

describe("formatAuthDoctorReport", () => {
  it("formats findings and repair hints for CLI output", () => {
    const report = createAuthDoctorReport({ auth: undefined, storage: storage() })

    expect(formatAuthDoctorReport(report)).toContain("restore-opencode-auth")
    expect(formatAuthDoctorReport(report)).toContain("missing-opencode-auth")
  })

  it("formats runtime metadata when provided", () => {
    const report = createAuthDoctorReport({
      auth: undefined,
      storage: storage(),
      runtime: { antigravityVersion: "1.19.0", antigravityVersionSource: "api" },
    })

    expect(formatAuthDoctorReport(report)).toContain("Antigravity version: 1.19.0 (api)")
  })
})
