/**
 * Terminal quota waits allow a seven-day reset plus margin while staying below
 * the signed 32-bit millisecond timer limit (2^31 - 1 ms).
 */
export const MAX_TERMINAL_HOLD_MS = 691_200_000;
