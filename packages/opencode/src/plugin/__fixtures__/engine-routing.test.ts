import {
  VaultBillingAttempt as BillingAttempt,
  observeVaultServed as observeServed,
  observeVaultUpstream as observeUpstream,
  reportVaultExhaustion as reportExhaustion,
} from '@cortexkit/antigravity-auth-core/engine'
import { openCodeRouting } from '../shared/engine-routing'

export const observeVaultServed = observeServed.bind(undefined, openCodeRouting)
export const observeVaultUpstream = observeUpstream.bind(
  undefined,
  openCodeRouting,
)
export const reportVaultExhaustion = reportExhaustion.bind(
  undefined,
  openCodeRouting,
)

export class VaultBillingAttempt extends BillingAttempt {
  constructor(
    ...args: ConstructorParameters<typeof BillingAttempt> extends [
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never
  ) {
    super(openCodeRouting.report, ...args)
  }
}
