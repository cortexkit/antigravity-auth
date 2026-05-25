import { detectAuthStorageDrift } from "./auth-drift"
import type { AccountMetadataV3, AccountStorageV4 } from "./storage"
import type { AuthDetails } from "./types"

export type AuthDoctorStatus = "ok" | "warning" | "repairable" | "error"

export type AuthDoctorFindingCode =
  | "auth-matches-storage"
  | "missing-opencode-auth"
  | "non-oauth-opencode-auth"
  | "refresh-token-not-in-storage"
  | "no-account-storage"
  | "no-enabled-accounts"
  | "active-index-out-of-range"
  | "active-account-disabled"
  | "verification-required"

export type AuthDoctorRepair =
  | "restore-opencode-auth"
  | "clamp-active-index"
  | "select-enabled-account"
  | "verify-account"

export interface AuthDoctorFinding {
  code: AuthDoctorFindingCode
  severity: "info" | "warning" | "error"
  message: string
  repair?: AuthDoctorRepair
  accountEmail?: string
}

export interface AuthDoctorReport {
  status: AuthDoctorStatus
  summary: string
  findings: AuthDoctorFinding[]
  runtime?: AuthDoctorRuntimeMetadata
}

export interface AuthDoctorRuntimeMetadata {
  antigravityVersion: string
  antigravityVersionSource: string
}

export interface CreateAuthDoctorReportInput {
  auth: AuthDetails | undefined | null
  storage: AccountStorageV4 | null | undefined
  runtime?: AuthDoctorRuntimeMetadata
}

function isEnabled(account: AccountMetadataV3): boolean {
  return account.enabled !== false
}

function statusFromFindings(findings: AuthDoctorFinding[]): AuthDoctorStatus {
  if (findings.some((finding) => finding.repair && finding.severity === "error")) {
    return "repairable"
  }
  if (findings.some((finding) => finding.severity === "error")) {
    return "error"
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "warning"
  }
  return "ok"
}

function summaryFromStatus(status: AuthDoctorStatus): string {
  switch (status) {
    case "ok":
      return "OpenCode auth and Antigravity account storage are in sync."
    case "repairable":
      return "Auth drift detected. One or more safe repairs are available."
    case "warning":
      return "Auth is usable, but one or more accounts need attention."
    case "error":
      return "Auth state is not usable and no safe automatic repair is available."
  }
}

export function createAuthDoctorReport(input: CreateAuthDoctorReportInput): AuthDoctorReport {
  const findings: AuthDoctorFinding[] = []
  const drift = detectAuthStorageDrift(input.auth, input.storage)

  switch (drift.reason) {
    case "auth-matches-storage":
      findings.push({
        code: "auth-matches-storage",
        severity: "info",
        message: "OpenCode OAuth refresh token exists in Antigravity account storage.",
        accountEmail: drift.account?.email,
      })
      break
    case "missing-opencode-auth":
      findings.push({
        code: "missing-opencode-auth",
        severity: "error",
        message: "OpenCode auth.json has no Google OAuth entry, but Antigravity account storage has a restorable account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email,
      })
      break
    case "non-oauth-opencode-auth":
      findings.push({
        code: "non-oauth-opencode-auth",
        severity: "error",
        message: "OpenCode Google auth is not OAuth, but Antigravity account storage has a restorable OAuth account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email,
      })
      break
    case "refresh-token-not-in-storage":
      findings.push({
        code: "refresh-token-not-in-storage",
        severity: "error",
        message: "OpenCode Google OAuth refresh token does not match any stored Antigravity account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email,
      })
      break
    case "no-account-storage":
      findings.push({
        code: "no-account-storage",
        severity: "error",
        message: "No Antigravity account storage was found.",
      })
      break
    case "no-enabled-accounts":
      findings.push({
        code: "no-enabled-accounts",
        severity: "error",
        message: "Antigravity account storage exists, but all accounts are disabled.",
      })
      break
  }

  const storage = input.storage
  if (storage && storage.accounts.length > 0) {
    if (!Number.isInteger(storage.activeIndex) || storage.activeIndex < 0 || storage.activeIndex >= storage.accounts.length) {
      findings.push({
        code: "active-index-out-of-range",
        severity: "error",
        message: `Active account index ${storage.activeIndex} is outside the stored account range.`,
        repair: "clamp-active-index",
      })
    } else {
      const activeAccount = storage.accounts[storage.activeIndex]
      if (activeAccount && !isEnabled(activeAccount) && storage.accounts.some(isEnabled)) {
        findings.push({
          code: "active-account-disabled",
          severity: "error",
          message: "The active account is disabled while another enabled account is available.",
          repair: "select-enabled-account",
          accountEmail: activeAccount.email,
        })
      }
    }

    for (const account of storage.accounts) {
      if (account.verificationRequired) {
        findings.push({
          code: "verification-required",
          severity: "warning",
          message: account.verificationRequiredReason ?? "Account requires Google verification before it can be used.",
          repair: "verify-account",
          accountEmail: account.email,
        })
      }
    }
  }

  const status = statusFromFindings(findings)
  return {
    status,
    summary: summaryFromStatus(status),
    findings,
    runtime: input.runtime,
  }
}

export function formatAuthDoctorReport(report: AuthDoctorReport): string {
  const lines = [
    "Antigravity auth doctor",
    `Status: ${report.status}`,
    report.summary,
    "",
  ]

  if (report.runtime) {
    lines.push(`Antigravity version: ${report.runtime.antigravityVersion} (${report.runtime.antigravityVersionSource})`)
    lines.push("")
  }

  for (const finding of report.findings) {
    const repair = finding.repair ? ` | repair: ${finding.repair}` : ""
    const account = finding.accountEmail ? ` | account: ${finding.accountEmail}` : ""
    lines.push(`- [${finding.severity}] ${finding.code}${account}${repair}`)
    lines.push(`  ${finding.message}`)
  }

  return lines.join("\n")
}
