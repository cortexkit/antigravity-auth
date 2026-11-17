import { expect, test } from 'bun:test'
import * as core from '../../packages/core/src/common-auth-embedded/fs/private-files.js'
import * as opencode from '../../packages/opencode/src/common-auth-embedded/fs/private-files.js'

for (const [profile, module] of Object.entries({ core, opencode }))
  test(`${profile} addon-load refusal keeps its reason off the host-visible message`, () => {
    const cause = Object.assign(new Error('synthetic addon failure'), {
      code: 'ERR_PRIVATE_FILES_UNAVAILABLE',
      reason: 'native-addon-unavailable',
    })
    const error = new module.PrivateFileError(
      'synthetic-owned-file',
      'read',
      cause,
    )
    expect(error.reason).toBe('native-addon-unavailable')
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('could not be loaded')
    expect(error.message).toContain('nothing was read or written')
    expect(error.message).not.toMatch(
      /\d|rate limited|rate_limit|resource_exhausted|try again later|unavailable|exhausted|overloaded/i,
    )
  })
