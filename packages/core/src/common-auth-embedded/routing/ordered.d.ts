import { type AdmissionInput, type AdmissionResult } from './admission.js';
export type RoutingMode = 'ordered' | 'sticky-balanced';
/** Where `ordered` routing places the former main row. */
export type OrderedPlacement = 'roster' | 'main-first' | 'fallback-first';
export interface ResolvedRoutingMode {
    mode: RoutingMode;
    placement: OrderedPlacement;
}
/** The former main row's id when the caller supplies none. */
export declare const DEFAULT_FORMER_MAIN_ID = "main";
/**
 * Resolves a persisted `routing.mode` value. `main-first` and
 * `fallback-first` are aliases of `ordered` that move the former main row;
 * an absent or unrecognised value is `ordered` in roster order. The
 * persisted value is only read here, never rewritten.
 */
export declare function resolveRoutingMode(value: unknown): ResolvedRoutingMode;
/**
 * Orders `ids` (in roster order) for a placement: `main-first` moves the row
 * named `formerMainId` to the front, `fallback-first` to the back, and
 * `roster` (or a missing former main row) keeps roster order.
 */
export declare function orderForPlacement(ids: readonly string[], placement: OrderedPlacement, formerMainId?: string): string[];
export interface OrderedRouteInput extends AdmissionInput {
    placement?: OrderedPlacement;
    formerMainId?: string;
    /** Killswitch verdict per row; `false` drops the row, a missing row passes. */
    killswitch?: ReadonlyMap<string, boolean>;
}
export interface OrderedRoute {
    /** Admitted, non-killed row ids in the order they are to be tried. */
    order: string[];
    admission: AdmissionResult;
}
export declare function routeOrdered(input: OrderedRouteInput): OrderedRoute;
export interface OrderedAttempt {
    id: string;
    /** The response status; undefined when no response arrived. */
    status?: number;
}
/**
 * The next row to try, given the attempts so far: the first row when none
 * has been tried, the next untried row when the last attempt's status is one
 * of `retryStatuses`, and undefined otherwise (the last response stands) or
 * when every row has been tried.
 */
export declare function nextOrderedAttempt(order: readonly string[], attempts: readonly OrderedAttempt[], retryStatuses: readonly number[]): string | undefined;
