import { type RowEditor } from './identity.js';
import { type CredentialBinding, type CredentialStamp, type PoolRow, type ProviderStateCodec, type QuotaCodec } from './schema.js';
/** Key, inside a credential stamp, of an attributed enable or disable. */
export declare const TRANSITION_STAMP_KEY = "transition";
/**
 * Key, inside a per-row config entry, of the mark of the last transition the
 * config carries out. Older readers ignore it.
 */
export declare const TRANSITION_MARK_KEY = "transitionMark";
/**
 * An attributed enable or disable as its state write records it: `mark` is
 * unique to that write, `enabled` is the flag it sets, and `reason` the
 * disabled reason (a disable's only).
 */
export interface StampedTransition {
    mark: string;
    enabled: boolean;
    reason?: string;
}
/**
 * Carries a transition out in a config being edited: the row's enabled flag
 * and reason as the transition says, and its mark recorded in the entry (a
 * row without an entry gets one at epoch 1, as `disableIn` gives it). An
 * enable then applies the duplicate-identity rule, as every write that
 * enables an OAuth row with a known identity does: the earlier row in roster
 * order keeps the identity.
 */
export declare function applyTransition(editor: RowEditor, id: string, transition: StampedTransition): void;
/** How a row left between the two writes of an operation is completed. */
export type TornCompletion = {
    kind: 'replace';
    stamp: CredentialStamp & {
        binding: CredentialBinding;
    };
} | {
    kind: 'identity';
    identity: string;
} | {
    kind: 'transition';
    transition: StampedTransition;
};
/** Rows left between the two writes of an operation, by row id. */
export declare function tornStamps(config: Record<string, unknown>, state: Record<string, unknown>, codec: QuotaCodec, options?: {
    requireCredentialStamps?: boolean;
}): Map<string, TornCompletion>;
/**
 * The config half of a replacement: the row's entry moves to the new epoch,
 * loses its quota and needs a first reading; its roster row gets the new
 * identity (or loses the old one) and, for an API key, the new endpoint.
 * Disabling later rows that share the new identity is left to the caller
 * (`disableIdentityDuplicates`), so several rows can be bound first.
 */
export declare function bindReplacement(editor: RowEditor, id: string, credentialEpoch: number, binding: CredentialBinding): void;
/**
 * The config with every torn row completed as its interrupted write would
 * have left it, and the ids completed. The config passed in is not modified;
 * when nothing is torn it is returned as is.
 */
export declare function completeTornRows(config: Record<string, unknown>, state: Record<string, unknown>, codec: QuotaCodec, options?: {
    requireCredentialStamps?: boolean;
}): {
    config: Record<string, unknown>;
    torn: string[];
};
/**
 * The rows every reader gets. A torn row is shown completed (the identity,
 * endpoint and epoch its stamp names, beside the credential it stamps), is
 * marked `torn` and is never a candidate; every other row is as on disk.
 * With `requireCredentialStamps`, a row whose stamp is not `bound` is marked
 * `unbound` and is never a candidate either. A torn row is shown with the
 * stamp of the interrupted write, which binds the completed row, so it is not
 * unbound; once a store write puts its completion on disk it is no longer
 * torn and is a candidate again like any other row.
 */
export declare function loadRows(config: Record<string, unknown>, state: Record<string, unknown>, codec: QuotaCodec, options?: {
    requireCredentialStamps?: boolean;
    providerState?: ProviderStateCodec;
}): PoolRow[];
