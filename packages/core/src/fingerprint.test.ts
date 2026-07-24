import { describe, expect, it } from 'bun:test'

import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityHarnessLoadCodeAssistUserAgent,
  buildAntigravityHarnessPlatformArch,
  buildAntigravityHarnessUserAgent,
  buildAntigravityLoadCodeAssistMetadata,
  clearSessionFingerprint,
  generateFingerprint,
  getSessionFingerprint,
  regenerateSessionFingerprint,
  updateFingerprintVersion,
} from './fingerprint.ts'

describe('Antigravity fingerprint', () => {
  describe('User-Agent normalization', () => {
    it('maps darwin/arm64 verbatim', () => {
      expect(buildAntigravityHarnessPlatformArch('darwin', 'arm64')).toBe(
        'darwin/arm64',
      )
    })

    it('normalizes win32 → windows and x64 → amd64', () => {
      expect(buildAntigravityHarnessPlatformArch('win32', 'x64')).toBe(
        'windows/amd64',
      )
    })

    it('builds the captured agy CLI User-Agent with auth_method=consumer', () => {
      expect(buildAntigravityHarnessUserAgent('1.1.6', 'darwin', 'arm64')).toBe(
        'antigravity/cli/1.1.6 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)',
      )
      expect(buildAntigravityHarnessUserAgent('1.1.6', 'win32', 'x64')).toBe(
        'antigravity/cli/1.1.6 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)',
      )
    })

    it('loadCodeAssist UA is the canonical harness UA', () => {
      expect(buildAntigravityHarnessLoadCodeAssistUserAgent()).toBe(
        buildAntigravityHarnessUserAgent(),
      )
    })
  })

  describe('bootstrap headers', () => {
    it('contains only the captured agy CLI metadata (no X-Goog-Api-Client / Client-Metadata)', () => {
      const headers = buildAntigravityHarnessBootstrapHeaders('token')

      expect(headers).toEqual({
        'User-Agent': expect.stringMatching(
          /^antigravity\/cli\/1\.1\.6 \(aidev_client; os_type=.+; arch=.+; auth_method=consumer\)$/,
        ),
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      })
      expect(headers['X-Goog-Api-Client']).toBeUndefined()
      expect(headers['Client-Metadata']).toBeUndefined()
    })

    it('loadCodeAssist metadata only carries ideType=ANTIGRAVITY', () => {
      expect(buildAntigravityLoadCodeAssistMetadata()).toEqual({
        ideType: 'ANTIGRAVITY',
      })
    })
  })

  describe('generated fingerprint metadata', () => {
    it('mirrors the captured User-Agent and antigravity-cli identity', () => {
      const fingerprint = generateFingerprint()

      expect(fingerprint.userAgent).toBe(buildAntigravityHarnessUserAgent())
      expect(fingerprint.apiClient).toBe('antigravity-cli')
      expect(fingerprint.clientMetadata).toEqual({
        ideType: 'ANTIGRAVITY',
        platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
        pluginType: 'GEMINI',
      })
      expect(fingerprint.deviceId).toBeTruthy()
      expect(fingerprint.sessionToken).toBeTruthy()
      expect(typeof fingerprint.createdAt).toBe('number')
    })
  })

  describe('old-fingerprint migration', () => {
    it('rewrites legacy randomized / pre-1.1.3 fingerprints to the captured UA', () => {
      const fingerprint = {
        deviceId: 'device',
        sessionToken: 'session',
        userAgent: 'antigravity/1.18.3 win32/x64',
        apiClient: 'google-cloud-sdk vscode/1.96.0',
        clientMetadata: {
          ideType: 'ANTIGRAVITY',
          platform: 'WINDOWS',
          pluginType: 'GEMINI',
        },
        createdAt: 0,
      }

      expect(updateFingerprintVersion(fingerprint)).toBe(true)
      expect(fingerprint.userAgent).toBe(buildAntigravityHarnessUserAgent())
    })

    it('returns false and leaves the User-Agent unchanged when already up to date', () => {
      const fingerprint = generateFingerprint()
      expect(updateFingerprintVersion(fingerprint)).toBe(false)
    })
  })

  describe('session fingerprint lifecycle', () => {
    it('returns the same instance until regenerate or clear is called', () => {
      const first = getSessionFingerprint()
      const second = getSessionFingerprint()
      expect(first).toBe(second)
    })

    it('regenerate produces a fresh non-empty instance distinct from the previous one', () => {
      const original = getSessionFingerprint()
      const next = regenerateSessionFingerprint()
      expect(next).not.toBe(original)
      expect(next.deviceId).toBeTruthy()
      expect(next.sessionToken).toBeTruthy()
      expect(next.userAgent).toBe(buildAntigravityHarnessUserAgent())
    })

    it('clearSessionFingerprint forces the next call to mint a new instance', () => {
      const original = getSessionFingerprint()
      clearSessionFingerprint()
      const fresh = getSessionFingerprint()
      expect(fresh).not.toBe(original)
    })
  })
})
