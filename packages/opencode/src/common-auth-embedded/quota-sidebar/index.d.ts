import { type PaceView, type SidebarAppearance, type SidebarTheme, type Tone } from '@cortexkit/opencode-sidebar';
import type { JSX } from '@opentui/solid';
import type { QuotaWindowPart } from '../quota/format.js';
import type { ProjectedQuota } from '../quota/projection.js';
export { type PaceView, type SidebarAppearance, SidebarSection, SidebarStatRow, SidebarTextRow, type SidebarTheme, type Tone, } from '@cortexkit/opencode-sidebar';
export interface QuotaGroupView {
    title?: string;
    rows: readonly {
        part: QuotaWindowPart;
        pace?: PaceView;
    }[];
}
export interface AccountView {
    id: string;
    label: string;
    titleSuffix?: string;
    status: {
        text: string;
        tone: Tone;
    };
    blocked: boolean;
    indicatorTone: Tone;
    quota: ProjectedQuota | undefined;
    groups: readonly QuotaGroupView[];
    emptyQuotaText?: {
        expanded: string;
        collapsed: string;
    };
    /** Presentation decided by the plugin, never inferred from status or freshness. */
    collapsed?: {
        quotaTone?: Tone;
        muted?: boolean;
    };
}
export interface SidebarFrameProps {
    header: {
        badge: string;
        version?: string;
    };
    accounts: readonly AccountView[];
    theme?: SidebarTheme;
    appearance: SidebarAppearance;
    showQuota: boolean;
    now: number;
    collapsed: boolean;
    onToggle: () => void;
    beforeQuota?: (account: AccountView) => JSX.Element;
    afterQuota?: (account: AccountView) => JSX.Element;
    sections?: () => JSX.Element;
    collapsedSections?: () => JSX.Element;
}
export declare function SidebarFrame(props: SidebarFrameProps): any;
