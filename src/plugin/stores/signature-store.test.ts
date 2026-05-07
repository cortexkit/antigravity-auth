import { describe, expect, it } from "vitest";
import {
  createSignatureStore,
  createThoughtBuffer,
  defaultSignatureStore,
} from "./signature-store";

// ─── createSignatureStore ─────────────────────────────────────────────────────

describe("createSignatureStore", () => {
  it("returns undefined for a key that was never set", () => {
    const store = createSignatureStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a value by key", () => {
    const store = createSignatureStore();
    store.set("k1", { text: "hello thinking", signature: "sig-abc" });
    expect(store.get("k1")).toEqual({ text: "hello thinking", signature: "sig-abc" });
  });

  it("reports has() as false for unknown key", () => {
    const store = createSignatureStore();
    expect(store.has("nope")).toBe(false);
  });

  it("reports has() as true after set()", () => {
    const store = createSignatureStore();
    store.set("key", { text: "t", signature: "s" });
    expect(store.has("key")).toBe(true);
  });

  it("delete() removes the key so has() returns false", () => {
    const store = createSignatureStore();
    store.set("del-me", { text: "x", signature: "y" });
    store.delete("del-me");
    expect(store.has("del-me")).toBe(false);
    expect(store.get("del-me")).toBeUndefined();
  });

  it("delete() on a non-existent key is a no-op", () => {
    const store = createSignatureStore();
    expect(() => store.delete("ghost")).not.toThrow();
  });

  it("overwriting a key stores the latest value", () => {
    const store = createSignatureStore();
    store.set("k", { text: "first", signature: "s1" });
    store.set("k", { text: "second", signature: "s2" });
    expect(store.get("k")).toEqual({ text: "second", signature: "s2" });
  });

  it("each createSignatureStore() call returns an independent store", () => {
    const storeA = createSignatureStore();
    const storeB = createSignatureStore();
    storeA.set("shared-key", { text: "only in A", signature: "sig-a" });
    expect(storeB.has("shared-key")).toBe(false);
  });

  it("handles empty-string key", () => {
    const store = createSignatureStore();
    store.set("", { text: "empty key", signature: "s" });
    expect(store.get("")).toEqual({ text: "empty key", signature: "s" });
  });

  it("handles many keys without collision", () => {
    const store = createSignatureStore();
    const N = 50;
    for (let i = 0; i < N; i++) {
      store.set(`key-${i}`, { text: `t${i}`, signature: `s${i}` });
    }
    for (let i = 0; i < N; i++) {
      expect(store.get(`key-${i}`)).toEqual({ text: `t${i}`, signature: `s${i}` });
    }
  });
});

// ─── createThoughtBuffer ─────────────────────────────────────────────────────

describe("createThoughtBuffer", () => {
  it("returns undefined for an index that was never set", () => {
    const buf = createThoughtBuffer();
    expect(buf.get(0)).toBeUndefined();
  });

  it("stores and retrieves text by numeric index", () => {
    const buf = createThoughtBuffer();
    buf.set(3, "thinking text");
    expect(buf.get(3)).toBe("thinking text");
  });

  it("index 0 is a valid key", () => {
    const buf = createThoughtBuffer();
    buf.set(0, "zero index");
    expect(buf.get(0)).toBe("zero index");
  });

  it("clear() removes all entries", () => {
    const buf = createThoughtBuffer();
    buf.set(0, "a");
    buf.set(1, "b");
    buf.set(2, "c");
    buf.clear();
    expect(buf.get(0)).toBeUndefined();
    expect(buf.get(1)).toBeUndefined();
    expect(buf.get(2)).toBeUndefined();
  });

  it("clear() on empty buffer is a no-op", () => {
    const buf = createThoughtBuffer();
    expect(() => buf.clear()).not.toThrow();
  });

  it("overwriting an index stores the latest text", () => {
    const buf = createThoughtBuffer();
    buf.set(5, "first");
    buf.set(5, "second");
    expect(buf.get(5)).toBe("second");
  });

  it("each createThoughtBuffer() call returns an independent buffer", () => {
    const bufA = createThoughtBuffer();
    const bufB = createThoughtBuffer();
    bufA.set(0, "only in A");
    expect(bufB.get(0)).toBeUndefined();
  });

  it("can store empty string", () => {
    const buf = createThoughtBuffer();
    buf.set(7, "");
    expect(buf.get(7)).toBe("");
  });
});

// ─── defaultSignatureStore ────────────────────────────────────────────────────

describe("defaultSignatureStore", () => {
  it("is a SignatureStore instance (has get/set/has/delete)", () => {
    expect(typeof defaultSignatureStore.get).toBe("function");
    expect(typeof defaultSignatureStore.set).toBe("function");
    expect(typeof defaultSignatureStore.has).toBe("function");
    expect(typeof defaultSignatureStore.delete).toBe("function");
  });

  it("is a module-level singleton (same reference on re-import)", async () => {
    const { defaultSignatureStore: imported } = await import("./signature-store");
    expect(imported).toBe(defaultSignatureStore);
  });
});
