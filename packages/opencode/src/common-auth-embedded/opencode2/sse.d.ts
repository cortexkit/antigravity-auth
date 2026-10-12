/** One server-sent event: its `event:` name, if any, and its joined `data:` lines. */
export interface ServerSentEvent {
    readonly event?: string;
    readonly data: string;
}
/**
 * A pass-through stream that hands every complete server-sent event to
 * `onEvent` while forwarding the original bytes unchanged, so the host still
 * consumes the body exactly once. A throwing `onEvent` is reported to
 * `onError` and never breaks the stream.
 */
export declare function watchServerSentEvents(onEvent: (event: ServerSentEvent) => void, onError: (error: unknown) => void): TransformStream<Uint8Array, Uint8Array>;
