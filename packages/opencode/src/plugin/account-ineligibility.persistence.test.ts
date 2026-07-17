import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loadAccounts, saveAccountsReplace } from "./storage"

let configDir = ""
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), "antigravity-ineligible-"))
  process.env.OPENCODE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  }
  await rm(configDir, { recursive: true, force: true })
})

describe("account ineligibility disk persistence", () => {
  it("round-trips the disabled state and eligibility metadata in the real account file", async () => {
    await saveAccountsReplace({
      version: 4,
      accounts: [
        {
          email: "blocked@example.com",
          refreshToken: "refresh-token",
          addedAt: 1,
          lastUsed: 2,
          enabled: false,
          accountIneligible: true,
          accountIneligibleAt: 100,
          accountIneligibleReason: "ACCOUNT_INELIGIBLE",
          eligibilityStateUpdatedAt: 100,
        },
      ],
      activeIndex: 0,
    })

    const storagePath = join(configDir, "antigravity-accounts.json")
    const raw = JSON.parse(await readFile(storagePath, "utf8")) as {
      accounts: Array<Record<string, unknown>>
    }
    expect(raw.accounts[0]).toMatchObject({
      enabled: false,
      accountIneligible: true,
      accountIneligibleAt: 100,
      accountIneligibleReason: "ACCOUNT_INELIGIBLE",
      eligibilityStateUpdatedAt: 100,
    })
    expect((await stat(storagePath)).mode & 0o777).toBe(0o600)

    await expect(loadAccounts()).resolves.toMatchObject({
      accounts: [expect.objectContaining({
        enabled: false,
        accountIneligible: true,
        accountIneligibleReason: "ACCOUNT_INELIGIBLE",
        eligibilityStateUpdatedAt: 100,
      })],
    })
  })
})
