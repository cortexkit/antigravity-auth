/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Uses the agy CLI 1.1.3 content-request identity captured with mitmproxy:
 * an Antigravity CLI User-Agent with explicit client, OS, architecture, and auth metadata.
 * The stored deviceId/sessionToken fields are
 * retained for account history, but content requests only send User-Agent.
 */

import * as crypto from "node:crypto";

export const AGY_CLI_VERSION = "1.1.3";
const ANTIGRAVITY_API_CLIENT = "antigravity-cli";

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  createdAt: number;
}
/**
 * Fingerprint version for history tracking.
 * Stores a snapshot of a fingerprint with metadata about when/why it was saved.
 */
export interface FingerprintVersion {
  fingerprint: Fingerprint;
  timestamp: number;
  reason: 'initial' | 'regenerated' | 'restored';
}

/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;

export interface FingerprintHeaders {
  "User-Agent": string;
}

function normalizeHarnessPlatform(platform = process.platform): string {
  return platform === "win32" ? "windows" : platform || "unknown";
}

function normalizeHarnessArch(arch = process.arch): string {
  switch (arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return arch || "unknown";
  }
}

export function buildAntigravityHarnessPlatformArch(
  platform = process.platform,
  arch = process.arch,
): string {
  return `${normalizeHarnessPlatform(platform)}/${normalizeHarnessArch(arch)}`;
}

export function buildAntigravityHarnessUserAgent(
  version = AGY_CLI_VERSION,
  platform = process.platform,
  arch = process.arch,
  authMethod = "consumer",
): string {
  const osType = normalizeHarnessPlatform(platform);
  const normalizedArch = normalizeHarnessArch(arch);
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${normalizedArch}; auth_method=${authMethod})`;
}

export function buildAntigravityHarnessLoadCodeAssistUserAgent(version = AGY_CLI_VERSION): string {
  return buildAntigravityHarnessUserAgent(version);
}

function platformToMetadataPlatform(platform: string = process.platform): "WINDOWS" | "MACOS" {
  return platform === "win32" ? "WINDOWS" : "MACOS";
}

export function buildAntigravityLoadCodeAssistMetadata(): Record<string, string> {
  return { ideType: "ANTIGRAVITY" };
}

export function buildAntigravityHarnessBootstrapHeaders(accessToken: string): Record<string, string> {
  return {
    "User-Agent": buildAntigravityHarnessLoadCodeAssistUserAgent(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

function generateDeviceId(): string {
  return crypto.randomUUID();
}

function generateSessionToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generate the per-account content-request fingerprint.
 * The outward HTTP identity is stable; deviceId/sessionToken remain unique for history.
 */
export function generateFingerprint(): Fingerprint {
  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: buildAntigravityHarnessUserAgent(),
    apiClient: ANTIGRAVITY_API_CLIENT,
    clientMetadata: {
      ideType: "ANTIGRAVITY",
      platform: platformToMetadataPlatform(),
      pluginType: "GEMINI",
    },
    createdAt: Date.now(),
  };
}

/**
 * Collect the current content-request fingerprint.
 */
export function collectCurrentFingerprint(): Fingerprint {
  return generateFingerprint();
}

/**
 * Update a saved fingerprint's User-Agent to the current Antigravity
 * agy CLI identity. This migrates older randomized fingerprints and the
 * pre-1.1.3 platform/arch-only User-Agent to the captured metadata form.
 * Returns true if the User-Agent was changed.
 */
export function updateFingerprintVersion(fingerprint: Fingerprint): boolean {
  const userAgent = buildAntigravityHarnessUserAgent();
  if (fingerprint.userAgent === userAgent) {
    return false;
  }

  fingerprint.userAgent = userAgent;
  return true;
}

/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 */
export function buildFingerprintHeaders(fingerprint: Fingerprint | null): Partial<FingerprintHeaders> {
  if (!fingerprint) {
    return {};
  }

  return {
    "User-Agent": fingerprint.userAgent,
  };
}

/**
 * Session-level fingerprint instance.
 * Generated once at module load, persists for the lifetime of the process.
 */
let sessionFingerprint: Fingerprint | null = null;

/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export function getSessionFingerprint(): Fingerprint {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export function regenerateSessionFingerprint(): Fingerprint {
  sessionFingerprint = generateFingerprint();
  return sessionFingerprint;
}
