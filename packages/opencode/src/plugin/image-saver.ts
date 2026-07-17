import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function getImageOutputDir(outputDir?: string): string {
  const resolved = outputDir ?? join(homedir(), ".opencode", "generated-images")

  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 })
  }
  chmodSync(resolved, 0o700)
  return resolved
}

function generateImageFilename(mimeType: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const random = Math.random().toString(36).substring(2, 8)

  let extension = "png"
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    extension = "jpg"
  } else if (mimeType.includes("gif")) {
    extension = "gif"
  } else if (mimeType.includes("webp")) {
    extension = "webp"
  }

  return `image-${timestamp}-${random}.${extension}`
}

export function saveImageToDisk(
  base64Data: string,
  mimeType: string,
  outputDir?: string,
): string {
  try {
    const resolvedOutputDir = getImageOutputDir(outputDir)
    const filePath = join(resolvedOutputDir, generateImageFilename(mimeType))
    writeFileSync(filePath, Buffer.from(base64Data, "base64"), { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return filePath
  } catch (error) {
    console.error("[image-saver] Failed to save image:", error)
    return ""
  }
}

export function processImageData(
  inlineData: { mimeType?: string; data?: string },
  outputDir?: string,
): string | null {
  const mimeType = inlineData.mimeType || "image/png"
  const data = inlineData.data
  if (!data) {
    return null
  }

  const filePath = saveImageToDisk(data, mimeType, outputDir)
  if (filePath) {
    return `![Generated Image](${filePath})\n\nImage saved to: \`${filePath}\`\n\nTo view: \`open "${filePath}"\``
  }

  return `![Generated Image](data:${mimeType};base64,${data})`
}
