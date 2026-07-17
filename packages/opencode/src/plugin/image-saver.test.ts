import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { processImageData, saveImageToDisk } from "./image-saver"

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-image-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe("generated image persistence", () => {
  it("writes decoded image bytes with private permissions", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = saveImageToDisk(Buffer.from("image-bytes").toString("base64"), "image/jpeg", directory)

    expect(filePath).toMatch(/\.jpg$/)
    await expect(readFile(filePath, "utf8")).resolves.toBe("image-bytes")
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it("converts inline image data to a markdown path", async () => {
    const directory = await createTemporaryDirectory()
    const markdown = processImageData({
      mimeType: "image/png",
      data: Buffer.from("png-bytes").toString("base64"),
    }, directory)

    expect(markdown).toContain("![Generated Image]")
    expect(markdown).toContain(directory)
  })

  it("ignores image parts without data", () => {
    expect(processImageData({ mimeType: "image/png" })).toBeNull()
  })
})
