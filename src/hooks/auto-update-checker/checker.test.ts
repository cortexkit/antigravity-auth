import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => fsMock);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isLocalDevMode / getLocalDevPath", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when no config files exist", async () => {
    const { isLocalDevMode } = await import("./checker");
    expect(isLocalDevMode("/some/project")).toBe(false);
  });

  it("returns null from getLocalDevPath when no config exists", async () => {
    const { getLocalDevPath } = await import("./checker");
    expect(getLocalDevPath("/some/project")).toBeNull();
  });

  it("returns null when config has no matching file:// plugin entry", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.json"),
    );
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["some-other-plugin@1.0.0"] }),
    );
    expect(getLocalDevPath("/project")).toBeNull();
  });

  it("returns path when config contains a file:// entry for the package", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.json"),
    );
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        plugin: ["file:///home/user/@expiren/opencode-antigravity-auth/dist/plugin.js"],
      }),
    );
    const result = getLocalDevPath("/project");
    expect(result).toContain("@expiren/opencode-antigravity-auth");
  });

  it("handles JSONC config with comments and trailing commas", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.jsonc"),
    );
    fsMock.readFileSync.mockReturnValue(
      `{
        // dev plugin
        "plugin": [
          "file:///home/user/@expiren/opencode-antigravity-auth/dist/plugin.js",
        ]
      }`,
    );
    const result = getLocalDevPath("/project");
    expect(result).toContain("@expiren/opencode-antigravity-auth");
  });

  it("returns null and does not throw when config file is malformed JSON", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("{ not valid json !!!}");
    expect(() => getLocalDevPath("/project")).not.toThrow();
    expect(getLocalDevPath("/project")).toBeNull();
  });
});

describe("findPluginEntry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsMock.existsSync.mockReturnValue(false);
  });

  it("returns null when no config files exist", async () => {
    const { findPluginEntry } = await import("./checker");
    expect(findPluginEntry("/project")).toBeNull();
  });

  it("returns entry with isPinned=false for bare package name", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["@expiren/opencode-antigravity-auth"] }),
    );
    const result = findPluginEntry("/project");
    expect(result).not.toBeNull();
    expect(result!.isPinned).toBe(false);
    expect(result!.pinnedVersion).toBeNull();
  });

  it("returns entry with isPinned=true for versioned package", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["@expiren/opencode-antigravity-auth@1.5.0"] }),
    );
    const result = findPluginEntry("/project");
    expect(result).not.toBeNull();
    expect(result!.isPinned).toBe(true);
    expect(result!.pinnedVersion).toBe("1.5.0");
  });

  it("returns isPinned=false for @latest entry", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["@expiren/opencode-antigravity-auth@latest"] }),
    );
    const result = findPluginEntry("/project");
    expect(result!.isPinned).toBe(false);
    expect(result!.pinnedVersion).toBeNull();
  });
});
