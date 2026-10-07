/**
 * Configuration loader for opencode-antigravity-auth plugin.
 *
 * Loads config from files.
 * Priority (lowest to highest):
 * 1. Schema defaults
 * 2. User config file
 * 3. Project config file
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createLogger, type Logger } from '../logger'
import {
  type AntigravityConfig,
  AntigravityConfigSchema,
  DEFAULT_CONFIG,
} from './schema'

// OpenCode 1 composition's config channel; a location passes its own logger.
const legacyLog = createLogger('config')

/** The logger capability config loading needs: invalid-file warnings. */
export type ConfigLoadLogger = Pick<Logger, 'warn'>

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Get the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 */
function getConfigDir(): string {
  // 1. Check for explicit override via env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR
  }

  // 2. Use ~/.config/opencode on all platforms (including Windows)
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

/**
 * Get the user-level config file path.
 */
export function getUserConfigPath(): string {
  return join(getConfigDir(), 'antigravity.json')
}

/**
 * Get the project-level config file path.
 */
export function getProjectConfigPath(directory: string): string {
  return join(directory, '.opencode', 'antigravity.json')
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load and parse a config file, returning null if not found or invalid.
 */
function loadConfigFile(
  path: string,
  log: ConfigLoadLogger,
): Partial<AntigravityConfig> | null {
  try {
    if (!existsSync(path)) {
      return null
    }

    const content = readFileSync(path, 'utf-8')
    const rawConfig = JSON.parse(content)

    // Validate with Zod (partial - we'll merge with defaults later)
    const result = AntigravityConfigSchema.partial().safeParse(rawConfig)

    if (!result.success) {
      log.warn('Config validation error', {
        path,
        issues: result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(', '),
      })
      return null
    }

    return result.data
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.warn('Invalid JSON in config file', { path, error: error.message })
    } else {
      log.warn('Failed to load config file', { path, error: String(error) })
    }
    return null
  }
}

/**
 * Deep merge two config objects, with override taking precedence.
 */
function mergeConfigs(
  base: AntigravityConfig,
  override: Partial<AntigravityConfig>,
): AntigravityConfig {
  return {
    ...base,
    ...override,
    // Deep merge signature_cache if both exist
    signature_cache: override.signature_cache
      ? {
          ...base.signature_cache,
          ...override.signature_cache,
        }
      : base.signature_cache,
  }
}

// =============================================================================
// Main Loader
// =============================================================================

/**
 * Load the complete configuration.
 *
 * @param directory - The project directory (for project-level config)
 * @param options.logger - Where invalid-file warnings go; a location passes
 *   its own logger, OpenCode 1 callers omit it.
 * @returns Fully resolved configuration
 */
export function loadConfig(
  directory: string,
  options: { logger?: ConfigLoadLogger } = {},
): AntigravityConfig {
  const log = options.logger ?? legacyLog
  // Start with defaults
  let config: AntigravityConfig = { ...DEFAULT_CONFIG }

  // Load user config file (if exists)
  const userConfigPath = getUserConfigPath()
  const userConfig = loadConfigFile(userConfigPath, log)
  if (userConfig) {
    config = mergeConfigs(config, userConfig)
  }

  // Load project config file (if exists) - overrides user config
  const projectConfigPath = getProjectConfigPath(directory)
  const projectConfig = loadConfigFile(projectConfigPath, log)
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig)
  }

  return config
}

/**
 * Check if a config file exists at the given path.
 */
export function configExists(path: string): boolean {
  return existsSync(path)
}

/**
 * Get the default logs directory.
 */
export function getDefaultLogsDir(): string {
  return join(getConfigDir(), 'antigravity-logs')
}

/**
 * One server location's resolved configuration. Each location loads its own
 * from its own project directory; nothing here is process-wide, so a second
 * location never sees the first location's values.
 */
export interface LocationConfig {
  readonly directory: string
  readonly config: AntigravityConfig
  /**
   * The keep_thinking policy: gates thought restoration/injection and disk
   * signature-cache ownership, never signature lookup or extraction.
   */
  readonly keepThinking: boolean
  readonly projectConfigPath: string
  readonly userConfigPath: string
}

/** Load one location's configuration from its project directory. */
export function createLocationConfig(
  directory: string,
  options: { logger?: ConfigLoadLogger } = {},
): LocationConfig {
  const config = loadConfig(directory, options)
  return {
    directory,
    config,
    keepThinking: config.keep_thinking,
    projectConfigPath: getProjectConfigPath(directory),
    userConfigPath: getUserConfigPath(),
  }
}

/**
 * Canonical identity for a file a process-shared controller owns: the
 * real path of the file, or of its nearest existing ancestor joined with
 * the missing remainder. Two spellings of one file (relative, symlinked
 * directory, `..` segments) therefore share one controller.
 */
export function canonicalizeOwnedPath(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

// =============================================================================
// OpenCode 1 single-location binding
//
// `initRuntimeConfig`/`getKeepThinking` hold the OpenCode 1 composition's one
// configuration for request helpers that have not yet adopted a location's
// `LocationConfig`. A location never writes this binding, so it cannot make
// one location's keep_thinking govern another's.
// =============================================================================

let runtimeConfig: AntigravityConfig | null = null

export function initRuntimeConfig(config: AntigravityConfig): void {
  runtimeConfig = config
}

export function getKeepThinking(): boolean {
  return runtimeConfig?.keep_thinking ?? false
}
