import type { RGBA } from '@opentui/core';
import type { JSX } from '@opentui/solid';
import type { QuotaWindowPart } from '../quota/format.js';
import type { ProjectedQuota } from '../quota/projection.js';
export type Tone = 'text' | 'textMuted' | 'accent' | 'success' | 'warning' | 'error';
export type SidebarTheme = Readonly<Partial<Record<Tone | 'background' | 'borderActive', RGBA | string | undefined>>>;
export interface SidebarAppearance {
    barWidth: number;
    barFilledChar: string;
    barEmptyChar: string;
    warnThreshold: number;
    errorThreshold: number;
}
export interface PaceView {
    text: string;
    tone: Tone;
    /** The elapsed-window percentage, not the difference from usage. */
    overlay?: {
        kind: 'reserve' | 'deficit';
        percent: number;
    };
}
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
/** A heading and its plugin-owned rows, with the frame's section spacing. */
export declare function SidebarSection(props: {
    title: string;
    children?: JSX.Element;
}): any;
/** Keep labels whole and reserve one blank cell before an ellipsized value. */
export declare function SidebarStatRow(props: {
    label: string;
    value: string;
    tone?: Tone;
}): any;
export declare function SidebarTextRow(props: {
    text: string;
    tone?: Tone;
    wrapMode?: JSX.IntrinsicElements['text']['wrapMode'];
}): any;
/** Borderless, controlled presentation; host registration and provider policy stay in the plugin. */
export declare function SidebarFrame(props: SidebarFrameProps): any;
