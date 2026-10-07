import { afterEach, describe, expect, it } from 'bun:test'
import {
  assertLoopbackProxyGuard,
  DOCUMENTED_LOOPBACK_EXCLUSION,
  evaluateLoopbackProxyGuard,
  type LoopbackProxyDecision,
  type LoopbackProxyEnv,
  LoopbackProxyGuardError,
  type LoopbackProxyGuardInput,
} from './proxy-guard.ts'

const BRIDGE_PORT = 34261
const OTHER_PORT = 46775
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}/v1beta/models/probe:streamGenerateContent?alt=sse`
const RECORDERS = {
  A: 'http://127.0.0.1:44199',
  B: 'http://127.0.0.1:44537',
} as const

/**
 * Provenance of the measured rows below. These are linux-arm64 measurements of
 * the npm-origin GA 2.0.22 binary, replayed independently. They are evidence
 * for the guard's rules on that platform only; they do not certify native
 * linux-amd64 behaviour, which is a separate measured gate.
 */
const ARM64_EVIDENCE = {
  platform: 'linux-arm64',
  package: '@opencode/cli-linux-arm64@2.0.22',
  binarySha256:
    'f27539d9c05c970d3eb9ad6a7724b75d3e638932c5423554f5ecbfe0ee2e8815',
  bunInsideHost: '1.4.2+744846f844374847c902b5e7fd59b4342a51ef99',
  gaSourceCommit: '527f0b931d1f9b3ebd34e106c51b31ce5db5b075',
  replay:
    'ga-proxy-independent-r2/replay (71 cases; 66 non-control rows below)',
} as const

type Verdict = 'direct' | 'proxied'

/**
 * One measured row: the environment template, the host's verdict for the
 * rewritten loopback request, and which recorder (if any) received it.
 * `{rec:A}` / `{rec:B}` are recorder proxy URLs, `{bridgePort}` is the bridge
 * port and `{otherPort}` is a different free port.
 */
type MeasuredRow = readonly [
  caseNo: string,
  id: string,
  verdict: Verdict,
  env: Readonly<Record<string, string>>,
  via: 'A' | 'B' | null,
]

const MEASURED_ROWS: readonly MeasuredRow[] = [
  ['006', 'single-HTTP_PROXY', 'proxied', { HTTP_PROXY: '{rec:A}' }, 'A'],
  ['007', 'single-http_proxy', 'proxied', { http_proxy: '{rec:A}' }, 'A'],
  ['008', 'single-HTTPS_PROXY', 'direct', { HTTPS_PROXY: '{rec:A}' }, null],
  ['009', 'single-https_proxy', 'direct', { https_proxy: '{rec:A}' }, null],
  ['010', 'single-ALL_PROXY', 'direct', { ALL_PROXY: '{rec:A}' }, null],
  ['011', 'single-all_proxy', 'direct', { all_proxy: '{rec:A}' }, null],
  [
    '012',
    'exclusion-HTTP_PROXY-NO_PROXY-literal',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1' },
    null,
  ],
  [
    '013',
    'exclusion-HTTP_PROXY-no_proxy-literal',
    'direct',
    { HTTP_PROXY: '{rec:A}', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '014',
    'exclusion-HTTP_PROXY-NO_PROXY-list',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: 'example.com,127.0.0.1,.internal.test' },
    null,
  ],
  [
    '015',
    'exclusion-HTTP_PROXY-NO_PROXY-list-spaces',
    'direct',
    {
      HTTP_PROXY: '{rec:A}',
      NO_PROXY: 'example.com, 127.0.0.1, .internal.test',
    },
    null,
  ],
  [
    '016',
    'exclusion-HTTP_PROXY-no_proxy-list',
    'direct',
    { HTTP_PROXY: '{rec:A}', no_proxy: 'localhost,127.0.0.1,::1' },
    null,
  ],
  [
    '017',
    'exclusion-HTTP_PROXY-NO_PROXY-localhost',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: 'localhost' },
    'A',
  ],
  [
    '018',
    'exclusion-HTTP_PROXY-NO_PROXY-ipv6-only',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '::1' },
    'A',
  ],
  [
    '019',
    'exclusion-HTTP_PROXY-NO_PROXY-ipv6-bracketed',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '[::1]' },
    'A',
  ],
  [
    '020',
    'exclusion-HTTP_PROXY-NO_PROXY-wildcard',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '*' },
    null,
  ],
  [
    '021',
    'exclusion-HTTP_PROXY-NO_PROXY-port-match',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1:{bridgePort}' },
    null,
  ],
  [
    '022',
    'exclusion-HTTP_PROXY-NO_PROXY-port-other',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1:{otherPort}' },
    'A',
  ],
  [
    '023',
    'exclusion-HTTP_PROXY-NO_PROXY-cidr',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.0/8' },
    'A',
  ],
  [
    '024',
    'exclusion-HTTP_PROXY-NO_PROXY-empty',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '' },
    'A',
  ],
  [
    '025',
    'exclusion-HTTP_PROXY-no_proxy-empty',
    'proxied',
    { HTTP_PROXY: '{rec:A}', no_proxy: '' },
    'A',
  ],
  [
    '026',
    'exclusion-HTTP_PROXY-conflict-upper-match',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: 'example.com' },
    'A',
  ],
  [
    '027',
    'exclusion-HTTP_PROXY-conflict-lower-match',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: 'example.com', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '028',
    'exclusion-HTTP_PROXY-conflict-lower-empty',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: '' },
    null,
  ],
  [
    '029',
    'exclusion-HTTP_PROXY-conflict-upper-empty',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '030',
    'exclusion-HTTP_PROXY-conflict-lower-quoted-dq',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: '""' },
    'A',
  ],
  [
    '031',
    'exclusion-HTTP_PROXY-conflict-lower-quoted-sq',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: "''" },
    'A',
  ],
  [
    '032',
    'exclusion-HTTP_PROXY-NO_PROXY-suffix-label',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '0.0.1' },
    null,
  ],
  [
    '033',
    'exclusion-HTTP_PROXY-NO_PROXY-suffix-dot',
    'direct',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '.0.0.1' },
    null,
  ],
  [
    '034',
    'exclusion-HTTP_PROXY-NO_PROXY-suffix-partial',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '27.0.0.1' },
    'A',
  ],
  [
    '035',
    'exclusion-HTTP_PROXY-NO_PROXY-other-literal',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: '127.0.0.2' },
    'A',
  ],
  [
    '036',
    'exclusion-HTTP_PROXY-NO_PROXY-space-separated',
    'proxied',
    { HTTP_PROXY: '{rec:A}', NO_PROXY: 'example.com 127.0.0.1' },
    'A',
  ],
  [
    '037',
    'exclusion-http_proxy-NO_PROXY-literal',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1' },
    null,
  ],
  [
    '038',
    'exclusion-http_proxy-no_proxy-literal',
    'direct',
    { http_proxy: '{rec:A}', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '039',
    'exclusion-http_proxy-NO_PROXY-list',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: 'example.com,127.0.0.1,.internal.test' },
    null,
  ],
  [
    '040',
    'exclusion-http_proxy-NO_PROXY-list-spaces',
    'direct',
    {
      http_proxy: '{rec:A}',
      NO_PROXY: 'example.com, 127.0.0.1, .internal.test',
    },
    null,
  ],
  [
    '041',
    'exclusion-http_proxy-no_proxy-list',
    'direct',
    { http_proxy: '{rec:A}', no_proxy: 'localhost,127.0.0.1,::1' },
    null,
  ],
  [
    '042',
    'exclusion-http_proxy-NO_PROXY-localhost',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: 'localhost' },
    'A',
  ],
  [
    '043',
    'exclusion-http_proxy-NO_PROXY-ipv6-only',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '::1' },
    'A',
  ],
  [
    '044',
    'exclusion-http_proxy-NO_PROXY-ipv6-bracketed',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '[::1]' },
    'A',
  ],
  [
    '045',
    'exclusion-http_proxy-NO_PROXY-wildcard',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '*' },
    null,
  ],
  [
    '046',
    'exclusion-http_proxy-NO_PROXY-port-match',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1:{bridgePort}' },
    null,
  ],
  [
    '047',
    'exclusion-http_proxy-NO_PROXY-port-other',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1:{otherPort}' },
    'A',
  ],
  [
    '048',
    'exclusion-http_proxy-NO_PROXY-cidr',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.0/8' },
    'A',
  ],
  [
    '049',
    'exclusion-http_proxy-NO_PROXY-empty',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '' },
    'A',
  ],
  [
    '050',
    'exclusion-http_proxy-no_proxy-empty',
    'proxied',
    { http_proxy: '{rec:A}', no_proxy: '' },
    'A',
  ],
  [
    '051',
    'exclusion-http_proxy-conflict-upper-match',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: 'example.com' },
    'A',
  ],
  [
    '052',
    'exclusion-http_proxy-conflict-lower-match',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: 'example.com', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '053',
    'exclusion-http_proxy-conflict-lower-empty',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: '' },
    null,
  ],
  [
    '054',
    'exclusion-http_proxy-conflict-upper-empty',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '', no_proxy: '127.0.0.1' },
    null,
  ],
  [
    '055',
    'exclusion-http_proxy-conflict-lower-quoted-dq',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: '""' },
    'A',
  ],
  [
    '056',
    'exclusion-http_proxy-conflict-lower-quoted-sq',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.1', no_proxy: "''" },
    'A',
  ],
  [
    '057',
    'exclusion-http_proxy-NO_PROXY-suffix-label',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '0.0.1' },
    null,
  ],
  [
    '058',
    'exclusion-http_proxy-NO_PROXY-suffix-dot',
    'direct',
    { http_proxy: '{rec:A}', NO_PROXY: '.0.0.1' },
    null,
  ],
  [
    '059',
    'exclusion-http_proxy-NO_PROXY-suffix-partial',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '27.0.0.1' },
    'A',
  ],
  [
    '060',
    'exclusion-http_proxy-NO_PROXY-other-literal',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: '127.0.0.2' },
    'A',
  ],
  [
    '061',
    'exclusion-http_proxy-NO_PROXY-space-separated',
    'proxied',
    { http_proxy: '{rec:A}', NO_PROXY: 'example.com 127.0.0.1' },
    'A',
  ],
  [
    '062',
    'precedence-HTTP_PROXY-vs-http_proxy',
    'proxied',
    { HTTP_PROXY: '{rec:A}', http_proxy: '{rec:B}' },
    'B',
  ],
  [
    '063',
    'precedence-HTTP_PROXY-vs-ALL_PROXY',
    'proxied',
    { HTTP_PROXY: '{rec:A}', ALL_PROXY: '{rec:B}' },
    'A',
  ],
  [
    '064',
    'precedence-http_proxy-vs-all_proxy',
    'proxied',
    { http_proxy: '{rec:A}', all_proxy: '{rec:B}' },
    'A',
  ],
  [
    '065',
    'precedence-HTTP_PROXY-vs-HTTPS_PROXY',
    'proxied',
    { HTTP_PROXY: '{rec:A}', HTTPS_PROXY: '{rec:B}' },
    'A',
  ],
  [
    '066',
    'precedence-ALL_PROXY-vs-all_proxy',
    'direct',
    { ALL_PROXY: '{rec:A}', all_proxy: '{rec:B}' },
    null,
  ],
  [
    '067',
    'precedence-http_proxy-empty-HTTP_PROXY-set',
    'proxied',
    { http_proxy: '', HTTP_PROXY: '{rec:A}' },
    'A',
  ],
  [
    '068',
    'precedence-HTTP_PROXY-empty-http_proxy-set',
    'proxied',
    { HTTP_PROXY: '', http_proxy: '{rec:A}' },
    'A',
  ],
  [
    '069',
    'precedence-http_proxy-quoted-dq-HTTP_PROXY-set',
    'direct',
    { http_proxy: '""', HTTP_PROXY: '{rec:A}' },
    null,
  ],
  [
    '070',
    'precedence-http_proxy-quoted-sq-HTTP_PROXY-set',
    'direct',
    { http_proxy: "''", HTTP_PROXY: '{rec:A}' },
    null,
  ],
  [
    '071',
    'precedence-HTTP_PROXY-quoted-dq-http_proxy-set',
    'proxied',
    { HTTP_PROXY: '""', http_proxy: '{rec:A}' },
    'A',
  ],
]

/**
 * Rows the host measured as direct but the guard refuses on purpose: label
 * suffix and leading-dot spellings of 127.0.0.1. The host routes these rows
 * direct, and the expected verdicts below record that. The guard accepts only
 * `*`, `127.0.0.1` and `127.0.0.1:<bridge port>`, so these rows fail closed
 * with the documented-exclusion error.
 */
const GUARD_STRICTER_THAN_HOST = new Set(['032', '033', '057', '058'])

function materialize(
  template: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(template)) {
    env[key] = value
      .replace('{rec:A}', RECORDERS.A)
      .replace('{rec:B}', RECORDERS.B)
      .replace('{bridgePort}', String(BRIDGE_PORT))
      .replace('{otherPort}', String(OTHER_PORT))
  }
  return env
}

function evaluate(env: LoopbackProxyEnv): LoopbackProxyDecision {
  return evaluateLoopbackProxyGuard({ env, target: BRIDGE_URL })
}

type Guard = (input: LoopbackProxyGuardInput) => LoopbackProxyDecision

/**
 * Compare a guard against every measured row and return the cases where it
 * disagrees. A refusal agrees with a proxied row only when it names the
 * variable the host actually used (the one pointing at the recorder that
 * received the request).
 */
function conformanceMismatches(guard: Guard): string[] {
  const mismatches: string[] = []
  for (const [caseNo, , verdict, template, via] of MEASURED_ROWS) {
    const decision = guard({ env: materialize(template), target: BRIDGE_URL })
    if (verdict === 'direct') {
      const expectOk = !GUARD_STRICTER_THAN_HOST.has(caseNo)
      if (decision.ok !== expectOk) mismatches.push(caseNo)
      continue
    }
    if (decision.ok) {
      mismatches.push(caseNo)
      continue
    }
    const usedVariable = Object.entries(template).find(
      ([, value]) => value === `{rec:${via}}`,
    )?.[0]
    if (decision.proxyVariable !== usedVariable) mismatches.push(caseNo)
  }
  return mismatches
}

/**
 * The mistake this guard exists to avoid: strip quoted-empty values first,
 * then pick lowercase-else-uppercase. On the measured host the raw lowercase
 * value is selected BEFORE quote stripping, so this version wrongly lets
 * `no_proxy=""` fall through to a matching `NO_PROXY` (it says direct while
 * the host proxies) and wrongly lets `http_proxy=""` fall through to
 * `HTTP_PROXY` (it refuses while the host goes direct).
 */
const normalizeThenFallThroughGuard: Guard = (input) => {
  const normalized: Record<string, string | undefined> = { ...input.env }
  for (const key of ['http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']) {
    const value = normalized[key]
    if (value === '""' || value === "''") normalized[key] = ''
  }
  return evaluateLoopbackProxyGuard({ env: normalized, target: input.target })
}

function expectRefused(
  decision: LoopbackProxyDecision,
): Extract<LoopbackProxyDecision, { ok: false }> {
  if (decision.ok)
    throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`)
  return decision
}

function expectAllowed(
  decision: LoopbackProxyDecision,
): Extract<LoopbackProxyDecision, { ok: true }> {
  if (!decision.ok)
    throw new Error(`expected an allowed decision, got ${decision.trigger}`)
  return decision
}

describe('measured arm64 rows', () => {
  it('keeps the complete, unique 66-row inventory with its pin provenance', () => {
    expect(ARM64_EVIDENCE.binarySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(MEASURED_ROWS).toHaveLength(66)
    const caseNos = MEASURED_ROWS.map(([caseNo]) => caseNo)
    expect(caseNos).toEqual(
      Array.from({ length: 66 }, (_, index) =>
        String(index + 6).padStart(3, '0'),
      ),
    )
    expect(new Set(MEASURED_ROWS.map(([, id]) => id)).size).toBe(66)
    for (const caseNo of GUARD_STRICTER_THAN_HOST) {
      expect(MEASURED_ROWS.find(([no]) => no === caseNo)?.[2]).toBe('direct')
    }
  })

  it('agrees with every measured row, including which variable the host used', () => {
    expect(conformanceMismatches(evaluateLoopbackProxyGuard)).toEqual([])
  })

  it('conservative policy: refuses host-direct suffix spellings (0.0.1, .0.0.1) as loopback entries', () => {
    for (const caseNo of GUARD_STRICTER_THAN_HOST) {
      const row = MEASURED_ROWS.find(([no]) => no === caseNo)
      if (row === undefined) throw new Error(`missing row ${caseNo}`)
      const decision = expectRefused(evaluate(materialize(row[3])))
      expect(decision.trigger).toBe('d-loopback-entry-not-direct')
    }
  })

  it('failure control: the normalize-then-fall-through guard fails conformance', () => {
    const mismatches = conformanceMismatches(normalizeThenFallThroughGuard)
    // Unsafe direction: quoted-empty no_proxy treated as absent, so the
    // uppercase NO_PROXY=127.0.0.1 is wrongly honoured while the host proxies.
    // Safe-but-wrong direction: quoted-empty http_proxy falls through to
    // HTTP_PROXY, refusing a request the host sends direct.
    expect(mismatches).toEqual(['030', '031', '055', '056', '069', '070'])
    const unsafe = mismatches.filter(
      (caseNo) =>
        MEASURED_ROWS.find(([no]) => no === caseNo)?.[2] === 'proxied',
    )
    expect(unsafe).toEqual(['030', '031', '055', '056'])
  })
})

describe('honoured and ignored proxy variables', () => {
  it('honours http_proxy and HTTP_PROXY for the http bridge URL', () => {
    for (const name of ['http_proxy', 'HTTP_PROXY'] as const) {
      const decision = expectRefused(evaluate({ [name]: RECORDERS.A }))
      expect(decision.trigger).toBe('a-no-loopback-exclusion')
      expect(decision.proxyVariable).toBe(name)
    }
  })

  it('ignores HTTPS_PROXY, https_proxy, ALL_PROXY and all_proxy, whatever their value', () => {
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]) {
      for (const value of [RECORDERS.A, 'not a url', '""']) {
        expect(evaluate({ [name]: value })).toEqual({
          ok: true,
          route: 'direct',
          basis: 'no-proxy-selected',
          proxyVariable: null,
        })
      }
    }
  })

  it('goes direct without any proxy, regardless of exclusion lists', () => {
    expect(expectAllowed(evaluate({})).basis).toBe('no-proxy-selected')
    expect(
      expectAllowed(evaluate({ NO_PROXY: 'localhost', no_proxy: '' })).basis,
    ).toBe('no-proxy-selected')
    expect(expectAllowed(evaluate({ NO_PROXY: '*' })).basis).toBe(
      'no-proxy-selected',
    )
  })

  it('treats a variable whose value is undefined as unset', () => {
    expect(
      expectAllowed(evaluate({ http_proxy: undefined, HTTP_PROXY: undefined }))
        .proxyVariable,
    ).toBeNull()
    const decision = expectRefused(
      evaluate({ http_proxy: undefined, HTTP_PROXY: RECORDERS.A }),
    )
    expect(decision.proxyVariable).toBe('HTTP_PROXY')
  })
})

describe('raw-before-strip precedence', () => {
  it('quoted-empty lowercase http_proxy suppresses HTTP_PROXY and routes direct', () => {
    for (const quoted of ['""', "''"]) {
      expect(evaluate({ http_proxy: quoted, HTTP_PROXY: RECORDERS.A })).toEqual(
        {
          ok: true,
          route: 'direct',
          basis: 'no-proxy-selected',
          proxyVariable: 'http_proxy',
        },
      )
    }
  })

  it('raw-empty lowercase http_proxy falls through to HTTP_PROXY', () => {
    const decision = expectRefused(
      evaluate({ http_proxy: '', HTTP_PROXY: RECORDERS.A }),
    )
    expect(decision.proxyVariable).toBe('HTTP_PROXY')
  })

  it('quoted-empty uppercase HTTP_PROXY does not suppress a real http_proxy', () => {
    const decision = expectRefused(
      evaluate({ HTTP_PROXY: '""', http_proxy: RECORDERS.A }),
    )
    expect(decision.proxyVariable).toBe('http_proxy')
  })

  it('quoted-empty uppercase HTTP_PROXY alone means no proxy', () => {
    expect(expectAllowed(evaluate({ HTTP_PROXY: "''" })).proxyVariable).toBe(
      'HTTP_PROXY',
    )
  })

  it('quoted-empty lowercase no_proxy suppresses a matching NO_PROXY and is refused', () => {
    for (const quoted of ['""', "''"]) {
      for (const proxyVariable of ['HTTP_PROXY', 'http_proxy'] as const) {
        const decision = expectRefused(
          evaluate({
            [proxyVariable]: RECORDERS.A,
            NO_PROXY: '127.0.0.1',
            no_proxy: quoted,
          }),
        )
        expect(decision.trigger).toBe('a-no-loopback-exclusion')
        expect(decision.proxyVariable).toBe(proxyVariable)
        expect(decision.exclusionVariable).toBe('no_proxy')
        expect(decision.message).toContain(
          'no_proxy is set and takes precedence over NO_PROXY',
        )
      }
    }
  })

  it('raw-empty lowercase no_proxy falls through to NO_PROXY', () => {
    const decision = expectAllowed(
      evaluate({
        HTTP_PROXY: RECORDERS.A,
        NO_PROXY: '127.0.0.1',
        no_proxy: '',
      }),
    )
    expect(decision).toEqual({
      ok: true,
      route: 'direct',
      basis: 'excluded',
      proxyVariable: 'HTTP_PROXY',
      exclusionVariable: 'NO_PROXY',
      directForm: 'loopback-host',
    })
  })

  it('padded or other quote strings never substitute for the quoted-empty value', () => {
    for (const padded of [' "" ', '"" ', "' '", '"', '"""', '``']) {
      const asProxy = expectRefused(
        evaluate({
          http_proxy: padded,
          HTTP_PROXY: RECORDERS.A,
          NO_PROXY: '127.0.0.1',
        }),
      )
      expect(asProxy.trigger).toBe('c-proxy-not-url')
      expect(asProxy.proxyVariable).toBe('http_proxy')

      const asExclusion = expectRefused(
        evaluate({
          HTTP_PROXY: RECORDERS.A,
          NO_PROXY: '127.0.0.1',
          no_proxy: padded,
        }),
      )
      expect(asExclusion.trigger).toBe('a-no-loopback-exclusion')
      expect(asExclusion.exclusionVariable).toBe('no_proxy')
    }
  })
})

describe('conflicts', () => {
  it('lowercase http_proxy wins over a different HTTP_PROXY', () => {
    expect(
      expectRefused(
        evaluate({ HTTP_PROXY: RECORDERS.A, http_proxy: RECORDERS.B }),
      ).proxyVariable,
    ).toBe('http_proxy')
  })

  it('a non-empty lowercase no_proxy wins over NO_PROXY and the lists are never merged', () => {
    const upperOnly = expectRefused(
      evaluate({
        HTTP_PROXY: RECORDERS.A,
        NO_PROXY: '127.0.0.1',
        no_proxy: 'example.com',
      }),
    )
    expect(upperOnly.exclusionVariable).toBe('no_proxy')
    const lowerMatch = expectAllowed(
      evaluate({
        HTTP_PROXY: RECORDERS.A,
        NO_PROXY: 'example.com',
        no_proxy: '*',
      }),
    )
    expect(lowerMatch).toMatchObject({
      exclusionVariable: 'no_proxy',
      directForm: 'wildcard',
    })
  })

  it('refuses nonstandard capitalisation of http_proxy as an unrecorded conflict', () => {
    for (const env of [
      { Http_Proxy: RECORDERS.A },
      { Http_Proxy: RECORDERS.A, NO_PROXY: '127.0.0.1' },
      { HTTP_proxy: '', http_proxy: RECORDERS.A, NO_PROXY: '127.0.0.1' },
    ]) {
      const decision = expectRefused(evaluate(env))
      expect(decision.trigger).toBe('b-unrecorded-conflict')
      expect(decision.conflictingVariables.length).toBe(1)
    }
  })

  it('refuses nonstandard capitalisation of no_proxy when a proxy applies', () => {
    const decision = expectRefused(
      evaluate({
        HTTP_PROXY: RECORDERS.A,
        NO_PROXY: '127.0.0.1',
        No_Proxy: 'x',
      }),
    )
    expect(decision.trigger).toBe('b-unrecorded-conflict')
    expect(decision.conflictingVariables).toEqual(['No_Proxy'])
  })

  it('ignores nonstandard no_proxy spellings when no proxy applies, and undefined values', () => {
    expect(evaluate({ No_Proxy: 'example.com' }).ok).toBe(true)
    expect(
      evaluate({
        HTTP_PROXY: RECORDERS.A,
        NO_PROXY: '127.0.0.1',
        No_Proxy: undefined,
      }).ok,
    ).toBe(true)
    expect(evaluate({ Http_Proxy: undefined }).ok).toBe(true)
  })
})

describe('exclusion lists', () => {
  it('accepts the supported direct forms, trimmed of spaces', () => {
    const cases = [
      ['127.0.0.1', 'loopback-host'],
      [' 127.0.0.1 ', 'loopback-host'],
      [`127.0.0.1:${BRIDGE_PORT}`, 'loopback-host-port'],
      ['*', 'wildcard'],
      ['  *', 'wildcard'],
    ] as const
    for (const [entry, form] of cases) {
      for (const exclusionVariable of ['NO_PROXY', 'no_proxy'] as const) {
        expect(
          evaluate({ http_proxy: RECORDERS.A, [exclusionVariable]: entry }),
        ).toEqual({
          ok: true,
          route: 'direct',
          basis: 'excluded',
          proxyVariable: 'http_proxy',
          exclusionVariable,
          directForm: form,
        })
      }
    }
  })

  it('accepts ordinary comma lists that contain a direct form anywhere', () => {
    for (const list of [
      'example.com,127.0.0.1',
      'example.com, 127.0.0.1, .internal.test',
      `localhost,::1,127.0.0.1:${BRIDGE_PORT}`,
      ',,127.0.0.1,,',
      'example.com,*',
      '127.0.0.1,',
    ]) {
      expect(evaluate({ HTTP_PROXY: RECORDERS.A, NO_PROXY: list }).ok).toBe(
        true,
      )
    }
  })

  it('refuses lists without a direct form, including empty tokens', () => {
    for (const list of [
      'example.com',
      'example.com,',
      ',',
      ' , ',
      'example.com,.internal.test',
    ]) {
      const decision = expectRefused(
        evaluate({ HTTP_PROXY: RECORDERS.A, NO_PROXY: list }),
      )
      expect(decision.trigger).toBe('a-no-loopback-exclusion')
    }
  })

  it('refuses loopback entries outside the accepted grammar (bypass attempts)', () => {
    const loopbackLike = [
      'localhost',
      'LOCALHOST',
      `localhost:${BRIDGE_PORT}`,
      '::1',
      '[::1]',
      `[::1]:${BRIDGE_PORT}`,
      '127.0.0.0/8',
      `127.0.0.1:${OTHER_PORT}`,
      `127.0.0.1:0${BRIDGE_PORT}`,
      '127.0.0.1:',
      '127.0.0.1/',
      '127.0.0.1.evil.test',
      `[127.0.0.1]:${BRIDGE_PORT}`,
      '127.1',
      '127.0.0.2',
      '0.0.1',
      '.0.0.1',
      '.127.0.0.1',
      '1',
      'http://127.0.0.1',
      '\t127.0.0.1',
      '127.0.0.1\n',
      '127.0.0.1;example.com',
      '"127.0.0.1"',
      "'127.0.0.1'",
      'example.com 127.0.0.1',
    ]
    for (const entry of loopbackLike) {
      const decision = expectRefused(
        evaluate({ HTTP_PROXY: RECORDERS.A, NO_PROXY: entry }),
      )
      expect({ entry, trigger: decision.trigger }).toEqual({
        entry,
        trigger: 'd-loopback-entry-not-direct',
      })
    }
    for (const entry of [
      '27.0.0.1',
      '2130706433',
      '0x7f000001',
      '*.example.com',
      '**',
    ]) {
      expect(evaluate({ HTTP_PROXY: RECORDERS.A, NO_PROXY: entry }).ok).toBe(
        false,
      )
    }
  })

  it('compares the port against the bridge URL being dispatched', () => {
    const env = {
      HTTP_PROXY: RECORDERS.A,
      NO_PROXY: `127.0.0.1:${BRIDGE_PORT}`,
    }
    expect(
      evaluateLoopbackProxyGuard({
        env,
        target: `http://127.0.0.1:${BRIDGE_PORT}/x`,
      }).ok,
    ).toBe(true)
    expect(
      evaluateLoopbackProxyGuard({
        env,
        target: `http://127.0.0.1:${OTHER_PORT}/x`,
      }).ok,
    ).toBe(false)
  })
})

describe('proxy URL validation', () => {
  it('refuses an honoured proxy that is not an absolute http(s) URL, even when loopback is excluded', () => {
    for (const value of [
      'not a url',
      'proxy.test:3128',
      '127.0.0.1:3128',
      'socks5://proxy.test:1080',
      'ftp://proxy.test',
      ' http://proxy.test:3128',
      'http://proxy.test:3128 ',
      '"http://proxy.test:3128"',
      'http://',
      'http:// bad host',
    ]) {
      for (const exclusion of [{}, { NO_PROXY: '127.0.0.1' }]) {
        const decision = expectRefused(
          evaluate({ http_proxy: value, ...exclusion }),
        )
        expect({ value, trigger: decision.trigger }).toEqual({
          value,
          trigger: 'c-proxy-not-url',
        })
      }
    }
  })

  it('validates only the selected proxy value', () => {
    expect(
      evaluate({
        http_proxy: RECORDERS.A,
        HTTP_PROXY: 'not a url',
        NO_PROXY: '127.0.0.1',
      }).ok,
    ).toBe(true)
    expect(evaluate({ http_proxy: '""', HTTP_PROXY: 'not a url' }).ok).toBe(
      true,
    )
  })

  it('accepts http and https proxy URLs, with or without credentials', () => {
    for (const value of [
      'http://proxy.test:3128',
      'https://proxy.test',
      'http://user:pw@proxy.test:3128/',
    ]) {
      expect(evaluate({ HTTP_PROXY: value, NO_PROXY: '127.0.0.1' }).ok).toBe(
        true,
      )
      expect(expectRefused(evaluate({ HTTP_PROXY: value })).trigger).toBe(
        'a-no-loopback-exclusion',
      )
    }
  })
})

describe('bridge target', () => {
  it('accepts only http://127.0.0.1:<port> targets and throws for anything else', () => {
    for (const target of [
      'https://127.0.0.1:34261/',
      'http://localhost:34261/',
      'http://127.0.0.1/',
      'http://127.0.0.1:80',
      'http://127.0.0.1:0/',
      'http://127.0.0.1:65536/',
      'http://127.0.0.1:034261/',
      'http://127.1:34261/',
      'http://user@127.0.0.1:34261/',
      'http://[::1]:34261/',
      'http://127.0.0.1.evil.test:34261/',
      'generativelanguage.googleapis.com',
    ]) {
      expect(() => evaluateLoopbackProxyGuard({ env: {}, target })).toThrow(
        TypeError,
      )
    }
    expect(
      evaluateLoopbackProxyGuard({ env: {}, target: 'http://127.0.0.1:65535' })
        .ok,
    ).toBe(true)
    expect(
      evaluateLoopbackProxyGuard({ env: {}, target: new URL(BRIDGE_URL) }).ok,
    ).toBe(true)
  })

  it('rejects a bad target before reading the environment', () => {
    const env = new Proxy<Record<string, string>>(
      {},
      {
        get() {
          throw new Error('environment was read')
        },
        ownKeys() {
          throw new Error('environment was enumerated')
        },
      },
    )
    expect(() =>
      evaluateLoopbackProxyGuard({ env, target: 'https://example.com/' }),
    ).toThrow(TypeError)
  })
})

describe('errors and assertion', () => {
  it('assertLoopbackProxyGuard throws a typed error naming the documented exclusion', () => {
    expect(DOCUMENTED_LOOPBACK_EXCLUSION).toBe('NO_PROXY=127.0.0.1')
    let caught: unknown
    try {
      assertLoopbackProxyGuard({
        env: { HTTP_PROXY: RECORDERS.A },
        target: BRIDGE_URL,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LoopbackProxyGuardError)
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof LoopbackProxyGuardError))
      throw new Error('unreachable')
    expect(caught.name).toBe('LoopbackProxyGuardError')
    expect(caught.trigger).toBe('a-no-loopback-exclusion')
    expect(caught.documentedLoopbackExclusion).toBe('NO_PROXY=127.0.0.1')
    expect(caught.message).toContain('NO_PROXY=127.0.0.1')
    expect(caught.decision.ok).toBe(false)
  })

  it('assertLoopbackProxyGuard returns the allowed decision', () => {
    expect(
      assertLoopbackProxyGuard({
        env: { HTTP_PROXY: RECORDERS.A, NO_PROXY: '127.0.0.1' },
        target: BRIDGE_URL,
      }),
    ).toMatchObject({
      ok: true,
      basis: 'excluded',
      directForm: 'loopback-host',
    })
  })

  it('every refusal names NO_PROXY=127.0.0.1 and leaks no environment value', () => {
    const secretProxy = 'http://alice:hunter2@corp-proxy.internal.test:3128'
    const refusals = [
      { HTTP_PROXY: secretProxy },
      { http_proxy: secretProxy, NO_PROXY: 'secret-host.internal.test' },
      { http_proxy: secretProxy, NO_PROXY: 'localhost.secret-zone.test' },
      { http_proxy: 'hunter2-not-a-url', NO_PROXY: '127.0.0.1' },
      { Http_Proxy: secretProxy },
      { HTTP_PROXY: secretProxy, NO_PROXY: '127.0.0.1', no_proxy: '""' },
    ]
    const triggers = new Set<string>()
    for (const env of refusals) {
      const decision = expectRefused(evaluate(env))
      triggers.add(decision.trigger)
      expect(decision.message).toContain(DOCUMENTED_LOOPBACK_EXCLUSION)
      const serialized = JSON.stringify(decision)
      for (const secret of [
        'alice',
        'hunter2',
        'corp-proxy',
        'secret-host',
        'secret-zone',
        '3128',
      ]) {
        expect(serialized).not.toContain(secret)
      }
    }
    expect([...triggers].sort()).toEqual([
      'a-no-loopback-exclusion',
      'b-unrecorded-conflict',
      'c-proxy-not-url',
      'd-loopback-entry-not-direct',
    ])
  })
})

describe('purity', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('never writes to the environment it reads, nor to process.env', () => {
    const writes: string[] = []
    const processEnvBefore = JSON.stringify(process.env)
    for (const [, , , template] of MEASURED_ROWS) {
      const target = Object.freeze(materialize(template))
      const env = new Proxy(target, {
        set(_, key) {
          writes.push(`set ${String(key)}`)
          return false
        },
        deleteProperty(_, key) {
          writes.push(`delete ${String(key)}`)
          return false
        },
        defineProperty(_, key) {
          writes.push(`define ${String(key)}`)
          return false
        },
      })
      const before = JSON.stringify(target)
      evaluateLoopbackProxyGuard({ env, target: BRIDGE_URL })
      expect(JSON.stringify(target)).toBe(before)
    }
    expect(writes).toEqual([])
    expect(JSON.stringify(process.env)).toBe(processEnvBefore)
  })

  it('does not read process.env implicitly', () => {
    const key = 'http_proxy'
    const previous = process.env[key]
    process.env[key] = RECORDERS.A
    try {
      expect(evaluate({}).ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('is synchronous and performs no network work', () => {
    let fetchCalls = 0
    const throwingFetch = async () => {
      fetchCalls++
      throw new Error('network is not allowed in the guard')
    }
    globalThis.fetch = Object.assign(throwingFetch, {
      preconnect: originalFetch.preconnect,
    })
    const decision = evaluate({
      HTTP_PROXY: RECORDERS.A,
      NO_PROXY: '127.0.0.1',
    })
    expect(decision instanceof Promise).toBe(false)
    expect(decision.ok).toBe(true)
    expect(expectRefused(evaluate({ HTTP_PROXY: RECORDERS.A })).ok).toBe(false)
    expect(fetchCalls).toBe(0)
  })
})
