import type { MenuAction, MenuContext } from './menu.js';
/** A fix the doctor can offer for one finding; applied only when chosen. */
export interface DoctorRepair {
    /** What the repair does, as the operator is asked about it. */
    label: string;
    apply(): void | Promise<void>;
}
export interface DoctorFinding {
    /** A stable plugin-chosen code, for tests and logs. */
    code: string;
    message: string;
    accountId?: string;
    repair?: DoctorRepair;
}
/** One plugin-registered check. A check only reads; repairs do the writing. */
export interface DoctorCheck {
    id: string;
    run(): readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>;
}
export interface DoctorReport {
    findings: DoctorFinding[];
}
/** The code of the finding recorded for a check that threw. */
export declare const DOCTOR_CHECK_FAILED = "doctor-check-failed";
/**
 * Runs every check in order. A check that throws becomes a finding of its
 * own instead of hiding what the other checks found.
 */
export declare function runDoctorChecks(checks: readonly DoctorCheck[]): Promise<DoctorReport>;
export declare function formatDoctorReport(title: string, report: DoctorReport): string[];
export interface RepairOutcome {
    applied: DoctorFinding[];
    declined: DoctorFinding[];
    failed: {
        finding: DoctorFinding;
        error: unknown;
    }[];
}
/**
 * Asks about each available repair in turn and applies only the ones the
 * operator answers yes to. Without an interactive terminal every question
 * is answered no, so nothing is written.
 */
export declare function applyChosenRepairs(context: MenuContext, report: DoctorReport): Promise<RepairOutcome>;
export interface DoctorActionOptions {
    checks: readonly DoctorCheck[];
    /** The report's heading; defaults to "Auth doctor". */
    title?: string;
    label?: string;
}
/** The menu's doctor: lists every finding, then offers each repair. */
export declare function doctorAction(options: DoctorActionOptions): MenuAction;
