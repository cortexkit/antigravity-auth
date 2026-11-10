import {
  SidebarFrame as Frame,
  type AccountView as FrameAccountView,
  type PaceView,
  type SidebarAppearance,
  type SidebarTheme,
  type Tone,
} from '@cortexkit/opencode-sidebar'
import type { JSX } from '@opentui/solid'
import { mapArray, mergeProps } from 'solid-js'
import type { QuotaWindowPart } from '../quota/format.js'
import { formatQuota, quotaWindowParts } from '../quota/format.js'
import type { ProjectedQuota } from '../quota/projection.js'

export {
  type PaceView,
  type SidebarAppearance,
  SidebarSection,
  SidebarStatRow,
  SidebarTextRow,
  type SidebarTheme,
  type Tone,
} from '@cortexkit/opencode-sidebar'

export interface QuotaGroupView {
  title?: string
  rows: readonly { part: QuotaWindowPart; pace?: PaceView }[]
}

export interface AccountView {
  id: string
  label: string
  titleSuffix?: string
  status: { text: string; tone: Tone }
  blocked: boolean
  indicatorTone: Tone
  quota: ProjectedQuota | undefined
  groups: readonly QuotaGroupView[]
  emptyQuotaText?: { expanded: string; collapsed: string }
  /** Presentation decided by the plugin, never inferred from status or freshness. */
  collapsed?: { quotaTone?: Tone; muted?: boolean }
}

export interface SidebarFrameProps {
  header: { badge: string; version?: string }
  accounts: readonly AccountView[]
  theme?: SidebarTheme
  appearance: SidebarAppearance
  showQuota: boolean
  now: number
  collapsed: boolean
  onToggle: () => void
  beforeQuota?: (account: AccountView) => JSX.Element
  afterQuota?: (account: AccountView) => JSX.Element
  sections?: () => JSX.Element
  collapsedSections?: () => JSX.Element
}

export function SidebarFrame(props: SidebarFrameProps) {
  const sources = new WeakMap<FrameAccountView, AccountView>()
  const accounts = mapArray(
    () => props.accounts,
    (account) => {
      // Keep account identity and live getters while the frame reads the caller's clock.
      const adapted = mergeProps(account, {
        get hasQuota() {
          return quotaWindowParts(account.quota, {
            now: props.now,
          }).windows.some((part) => part.reading === 'known')
        },
        get collapsedQuotaText() {
          return formatQuota(account.quota, { now: props.now, form: 'narrow' })
        },
        get quotaAge() {
          return quotaWindowParts(account.quota, { now: props.now }).age
        },
      })
      sources.set(adapted, account)
      return adapted
    },
  )
  return (
    <Frame
      {...props}
      accounts={accounts()}
      beforeQuota={(account) => {
        const source = sources.get(account)
        return source && props.beforeQuota?.(source)
      }}
      afterQuota={(account) => {
        const source = sources.get(account)
        return source && props.afterQuota?.(source)
      }}
    />
  )
}
