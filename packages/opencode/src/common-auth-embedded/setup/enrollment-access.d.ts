import type { ClaustrumEnrollmentConnection, ClaustrumEnrollmentStatus, ClaustrumRequestedGrant } from '../claustrum/enrollment.js';
import type { SetupEnrollmentAccess } from './types.js';
/** Check access on the enrollment connection, after the token has reached disk. */
export declare function confirmEnrollmentAccess(client: Pick<ClaustrumEnrollmentConnection, 'listScoped'>, status: Extract<ClaustrumEnrollmentStatus, {
    state: 'approved';
}>, tokenPath: string, configuredGrants: ReadonlyArray<ClaustrumRequestedGrant> | undefined): Promise<SetupEnrollmentAccess | undefined>;
export declare function enrollmentAccessLines(access: SetupEnrollmentAccess): string[];
