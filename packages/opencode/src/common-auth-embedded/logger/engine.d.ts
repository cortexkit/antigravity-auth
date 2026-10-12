import type { CaptureSink } from './capture-sink.js';
import { type RedactionOptions } from './redact.js';
export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';
/** A logger that writes to a file, and to a capture sink when one is given. */
export interface InitLoggerOptions extends RedactionOptions {
    /** Receives every emitted record, scrubbed, alongside the file. */
    captureSink?: CaptureSink;
    /**
     * Path of the file lines are appended to, or a function returning it.
     *
     * A function is what a host passes when its destination can move while the
     * process runs — an operator or a test changing the variable that names the
     * log file expects the next line to land in the new file, and a value
     * captured once at init would keep writing to the old one.
     */
    file: string | (() => string);
    /** Level floor applied when no `setLogLevel` call has overridden it. */
    level?: Level | (() => Level | undefined);
}
/**
 * A logger with no file: the capture sink is its only destination. Nothing
 * is written to disk or printed, for a host that forwards records to its own
 * log.
 */
export interface SinkOnlyLoggerOptions extends RedactionOptions {
    /** Receives every emitted record, scrubbed. */
    captureSink: CaptureSink;
    file?: undefined;
    /** Level floor applied when no `setLogLevel` call has overridden it. */
    level?: Level | (() => Level | undefined);
}
/**
 * What a logger is configured with: a file (`InitLoggerOptions`, the shape
 * every release before this one accepted, kept as its own interface so a
 * caller deriving a type from it with `Pick` or `extends` keeps compiling) or
 * a capture sink alone.
 */
export type LoggerOptions = InitLoggerOptions | SinkOnlyLoggerOptions;
export interface ChannelLogger {
    error(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
    trace(message: string, data?: unknown): void;
}
/**
 * A logger with its own file, level, redaction, capture sink and buffer.
 * Two instances in one process never touch each other's settings or lines,
 * so two plugins that load one shared copy of this module each keep their own
 * log by holding their own instance.
 */
export interface LoggerInstance {
    /** A logger whose lines carry `channel` and go to this instance's file. */
    createLogger(channel: string): ChannelLogger;
    /**
     * Point this instance at a host's file and level. Idempotent: calling it
     * again replaces both. A runtime level installed by `setLogLevel` is left
     * alone, because it is the operator's explicit choice and outranks the
     * floor a host computed at start-up.
     */
    configure(options: LoggerOptions): void;
    /** Operator override of the level floor; undefined removes it. */
    setLogLevel(level: Level | undefined): void;
    /**
     * Write whatever is buffered. Safe to call synchronously from a
     * process-exit handler, which is how each host drains the buffer on
     * shutdown.
     */
    flushLogs(): void;
}
/**
 * A logger instance of its own, configured with `options`. A plugin whose
 * copy of this module may be shared with another plugin in the same process
 * uses this instead of `initLogger`, so neither replaces the other's file,
 * level, redaction or capture sink.
 */
export declare function createLoggerInstance(options: LoggerOptions): LoggerInstance;
/**
 * Point the module's default logger at a host's file and level, and return
 * it. Idempotent: calling it again replaces both. A runtime level installed
 * by `setLogLevel` is deliberately left alone, because it is the operator's
 * explicit choice and outranks the floor a host computed at start-up.
 */
export declare function initLogger(options: LoggerOptions): LoggerInstance;
export declare function setLogLevel(l: Level | undefined): void;
/**
 * Write whatever the default logger has buffered. Safe to call synchronously
 * from a process-exit handler, which is how each host drains the buffer on
 * shutdown.
 */
export declare function flushLogs(): void;
export declare function createLogger(channel: string): ChannelLogger;
export declare function flushForTest(): Promise<void>;
/**
 * Return the default logger to its uninitialised state. Only a test needs
 * this: a single process runs every test file, so a file path left over from
 * one test would keep a later "logger was never initialised" case writing
 * lines.
 */
export declare function resetLoggerForTest(): void;
