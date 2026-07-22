import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.module("./checker", () => ({
  getCachedVersion: mock(),
  getLocalDevVersion: mock(),
  findPluginEntry: mock(),
  getLatestVersion: mock(),
  updatePinnedVersion: mock(),
}));

mock.module("./cache", () => ({
  invalidatePackage: mock(),
}));

mock.module("../../plugin/debug", () => ({
  debugLogToFile: mock(),
}));

import { createAutoUpdateCheckerHook } from "./index";
import { getCachedVersion, getLocalDevVersion, findPluginEntry, getLatestVersion, updatePinnedVersion } from "./checker";
import { invalidatePackage } from "./cache";

function createMockClient() {
  return {
    tui: {
      showToast: mock().mockResolvedValue(undefined),
    },
  };
}

function createPluginInfo(overrides: Partial<ReturnType<typeof findPluginEntry>> = {}) {
  return {
    configPath: "/test/.config/opencode/opencode.json",
    entry: "@cortexkit/opencode-antigravity-auth@1.2.6",
    pinnedVersion: "1.2.6",
    isPinned: true,
    ...overrides,
  };
}

describe("Auto Update Checker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("prerelease version handling", () => {
    it("skips auto-update for beta versions", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "1.2.7-beta.1",
        entry: "opencode-antigravity-auth@1.2.7-beta.1",
      }));
      (getCachedVersion as any).mockReturnValue(null);
      (getLatestVersion as any).mockResolvedValue("1.2.6");

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).not.toHaveBeenCalled();
      expect(updatePinnedVersion).not.toHaveBeenCalled();
      expect(invalidatePackage).not.toHaveBeenCalled();
      expect(client.tui.showToast).not.toHaveBeenCalled();
    });

    it("skips auto-update for alpha versions", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "2.0.0-alpha.3",
        entry: "opencode-antigravity-auth@2.0.0-alpha.3",
      }));
      (getCachedVersion as any).mockReturnValue(null);

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).not.toHaveBeenCalled();
    });

    it("skips auto-update for rc versions", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "1.3.0-rc.1",
        entry: "opencode-antigravity-auth@1.3.0-rc.1",
      }));
      (getCachedVersion as any).mockReturnValue(null);

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).not.toHaveBeenCalled();
    });

    it("skips auto-update when cached version is prerelease", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "1.2.6",
      }));
      (getCachedVersion as any).mockReturnValue("1.2.7-beta.2");

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).not.toHaveBeenCalled();
    });

    it("proceeds with update check for stable versions", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "1.2.5",
      }));
      (getCachedVersion as any).mockReturnValue(null);
      (getLatestVersion as any).mockResolvedValue("1.2.6");
      (updatePinnedVersion as any).mockReturnValue(true);

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).toHaveBeenCalled();
    });
  });

  describe("auto-update disabled", () => {
    it("shows notification but does not update when autoUpdate is false", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo({
        pinnedVersion: "1.2.5",
      }));
      (getCachedVersion as any).mockReturnValue(null);
      (getLatestVersion as any).mockResolvedValue("1.2.6");

      const hook = createAutoUpdateCheckerHook(client, "/test", { autoUpdate: false });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(getLatestVersion).toHaveBeenCalled();
      expect(updatePinnedVersion).not.toHaveBeenCalled();
      expect(invalidatePackage).not.toHaveBeenCalled();
      expect(client.tui.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            variant: "info",
          }),
        })
      );
    });
  });

  describe("session handling", () => {
    it("only checks once per hook instance", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);
      (findPluginEntry as any).mockReturnValue(createPluginInfo());
      (getCachedVersion as any).mockReturnValue(null);
      (getLatestVersion as any).mockResolvedValue("1.2.6");

      const hook = createAutoUpdateCheckerHook(client, "/test");
      
      hook.event({ event: { type: "session.created" } });
      hook.event({ event: { type: "session.created" } });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(findPluginEntry).toHaveBeenCalledTimes(1);
    });

    it("ignores child sessions (with parentID)", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);

      const hook = createAutoUpdateCheckerHook(client, "/test");
      hook.event({
        event: {
          type: "session.created",
          properties: { info: { parentID: "parent-123" } },
        },
      });

      await jest.runAllTimers();

      expect(findPluginEntry).not.toHaveBeenCalled();
    });

    it("ignores non-session.created events", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue(null);

      const hook = createAutoUpdateCheckerHook(client, "/test");
      hook.event({ event: { type: "message.created" } });

      await jest.runAllTimers();

      expect(findPluginEntry).not.toHaveBeenCalled();
    });
  });

  describe("local development mode", () => {
    it("skips update check in local dev mode", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue("1.2.7-dev");

      const hook = createAutoUpdateCheckerHook(client, "/test");
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(findPluginEntry).not.toHaveBeenCalled();
      expect(getLatestVersion).not.toHaveBeenCalled();
    });

    it("shows local dev toast when showStartupToast is true", async () => {
      const client = createMockClient();
      (getLocalDevVersion as any).mockReturnValue("1.2.7-dev");

      const hook = createAutoUpdateCheckerHook(client, "/test", { showStartupToast: true });
      hook.event({ event: { type: "session.created" } });

      await jest.runAllTimers();

      expect(client.tui.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            variant: "warning",
          }),
        })
      );
    });
  });
});
