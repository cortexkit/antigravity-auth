import { type RedactionOptions } from '../logger/index.js';
import type { ActionDefinition, CommandApplyResult, CommandDialogPayload, ItemDefinition, MenuAccount, MenuConfirmation, SectionContent, SectionSlot } from './model.js';
/** Where a dropped field is reported. Names only, never values. */
export interface SeamLogger {
    warn(message: string, data?: unknown): void;
}
/** Masks the secret-shaped parts of one string. */
export type TextRedactor = (text: string) => string;
/** The string redactor every value crossing the seam goes through. */
export declare function createTextRedactor(options?: RedactionOptions): TextRedactor;
/**
 * A failure whose message was written for the user. An action throws it to
 * show `message` with the stable `code`; any other thrown value is shown only
 * as a generic message, because its text may quote a request, a response or
 * a credential. `code` is lowercase letters, digits and dashes; anything else
 * is reported as `action-failed`.
 */
export declare class CommandError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
    });
}
/** What a failed action shows: a stable code and a message safe to display. */
export interface ProjectedFailure {
    code: string;
    text: string;
}
/** The code and message shown for an exception the seam cannot vouch for. */
export declare const ACTION_FAILED: ProjectedFailure;
/** The code and display text for a thrown value; never its raw text. */
export declare function projectFailure(error: unknown): ProjectedFailure;
/** A built-in item may carry the account it shows; plugin items cannot. */
export interface ResolvedItem extends ItemDefinition {
    account?: MenuAccount;
}
/** A section with its bodies, as the menu holds it between builds. */
export interface ResolvedSection {
    id: string;
    slot: SectionSlot;
    title: string;
    content: Omit<SectionContent, 'items'> & {
        items?: ResolvedItem[];
    };
}
/** The confirmation shown when an irreversible action names none. */
export declare const DEFAULT_IRREVERSIBLE_CONFIRMATION = "This cannot be undone. Continue?";
/** What every payload builder needs besides the payload itself. */
export interface SeamContext {
    logger: SeamLogger;
    redact: TextRedactor;
}
/**
 * The confirmation an action must pass before it runs, or undefined. An
 * irreversible action always has one, even when its definition (built
 * outside the type checker) names none.
 */
export declare function confirmationOf(action: ActionDefinition): MenuConfirmation | undefined;
/** The account fields a renderer may show; see `MenuAccount`. */
export declare function projectAccount(account: MenuAccount): MenuAccount;
/** The payload a host's TUI receives when the slash command opens. */
export declare function dialogPayload(command: string, title: string, sections: readonly ResolvedSection[], seam: SeamContext): CommandDialogPayload;
/** How an apply ended, before the seam turns it into a payload. */
export interface ApplyOutcome {
    ok: boolean;
    text: string;
    /** Present on every failure. */
    code?: string;
    needsConfirmation?: boolean;
}
/** An apply's result: the message and the refreshed menu. */
export declare function applyResult(command: string, title: string, sections: readonly ResolvedSection[], outcome: ApplyOutcome, seam: SeamContext): CommandApplyResult;
