/** The code of the finding recorded for a check that threw. */
export const DOCTOR_CHECK_FAILED = 'doctor-check-failed';
/**
 * Runs every check in order. A check that throws becomes a finding of its
 * own instead of hiding what the other checks found.
 */
export async function runDoctorChecks(checks) {
    const findings = [];
    for (const check of checks) {
        try {
            findings.push(...(await check.run()));
        }
        catch (error) {
            findings.push({
                code: DOCTOR_CHECK_FAILED,
                message: `Check ${check.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return { findings };
}
export function formatDoctorReport(title, report) {
    const lines = [title];
    if (report.findings.length === 0) {
        lines.push('No problems found.');
        return lines;
    }
    for (const finding of report.findings) {
        const repair = finding.repair ? ' (repair available)' : '';
        lines.push(`- ${finding.message}${repair}`);
    }
    return lines;
}
/**
 * Asks about each available repair in turn and applies only the ones the
 * operator answers yes to. Without an interactive terminal every question
 * is answered no, so nothing is written.
 */
export async function applyChosenRepairs(context, report) {
    const outcome = { applied: [], declined: [], failed: [] };
    for (const finding of report.findings) {
        const repair = finding.repair;
        if (!repair)
            continue;
        if (!(await context.confirm(`Apply repair: ${repair.label}?`))) {
            outcome.declined.push(finding);
            continue;
        }
        try {
            await repair.apply();
            outcome.applied.push(finding);
        }
        catch (error) {
            outcome.failed.push({ finding, error });
            context.print(`Repair failed: ${repair.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return outcome;
}
/** The menu's doctor: lists every finding, then offers each repair. */
export function doctorAction(options) {
    const title = options.title ?? 'Auth doctor';
    return {
        id: 'doctor',
        label: options.label ?? 'Auth doctor',
        hint: 'check accounts and offer repairs',
        async run(context) {
            const report = await runDoctorChecks(options.checks);
            for (const line of formatDoctorReport(title, report))
                context.print(line);
            const repairable = report.findings.filter((finding) => finding.repair);
            if (repairable.length === 0) {
                if (report.findings.length > 0)
                    context.print('No repairs are available.');
                return;
            }
            const outcome = await applyChosenRepairs(context, report);
            context.print(`Applied ${outcome.applied.length} of ${repairable.length} repair(s).`);
        },
    };
}
