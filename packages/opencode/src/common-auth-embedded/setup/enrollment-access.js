import { readClaustrumEnrollmentToken } from '../claustrum/enrollment.js';
function shellArgument(value) {
    if (/^[a-zA-Z0-9_:@./-]+$/.test(value))
        return value;
    return process.platform === 'win32'
        ? `'${value.replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
}
/** Check access on the enrollment connection, after the token has reached disk. */
export async function confirmEnrollmentAccess(client, status, tokenPath, configuredGrants) {
    const requestedGrants = status.requestedGrants ?? configuredGrants;
    if (!requestedGrants)
        return undefined;
    const grants = requestedGrants.map((grant) => ({
        grant,
        ...(status.approvedName !== undefined && {
            grantCommand: `ck auth grant --principal ${shellArgument(`enrolled:${status.approvedName}`)} --selector-kind ${grant.selector.exact === undefined ? 'category' : 'exact'} --selector ${shellArgument(grant.selector.exact ?? grant.selector.category)} --operation ${grant.operation}`,
        }),
    }));
    if (status.requestedGrantsStatus === 'dropped')
        return { state: 'older-vault', grants };
    try {
        if (!client.listScoped)
            return { state: 'unconfirmed', grants };
        const { token } = await readClaustrumEnrollmentToken(tokenPath);
        const inventory = await client.listScoped(token);
        const confirmed = grants.map((entry) => ({
            ...entry,
            reachableLogins: inventory.rows.filter((row) => row.operations.includes(entry.grant.operation) &&
                (entry.grant.selector.exact !== undefined
                    ? row.id === entry.grant.selector.exact
                    : row.categories.includes(entry.grant.selector.category))).length,
        }));
        return {
            state: confirmed.every((entry) => entry.reachableLogins > 0)
                ? 'reachable'
                : confirmed.some((entry) => entry.reachableLogins > 0)
                    ? 'partial'
                    : 'no-logins',
            grants: confirmed.map((entry) => {
                if (entry.reachableLogins === 0)
                    return entry;
                const { grantCommand: _, ...reachable } = entry;
                return reachable;
            }),
        };
    }
    catch {
        // A listing failure cannot undo approval, and its error may contain secrets.
        return { state: 'unconfirmed', grants };
    }
}
export function enrollmentAccessLines(access) {
    const lines = [];
    const remedy = access.grants.some((entry) => entry.grantCommand)
        ? 'run:'
        : 'check ck auth status for the approved name before granting access.';
    if (access.state === 'older-vault')
        lines.push(`Approved. This vault is too old to grant access with the approval; ${remedy}`);
    else if (access.state === 'no-logins')
        lines.push(`Approved, but no logins are reachable yet; ${remedy}`);
    else if (access.state === 'partial')
        lines.push(`Approved, but some requested access has no reachable logins yet; ${remedy}`);
    else if (access.state === 'unconfirmed')
        lines.push(`Approved, but access could not be confirmed; ${access.grants.some((entry) => entry.grantCommand) ? 'check ck auth status or run:' : remedy}`);
    for (const { grant, reachableLogins, grantCommand } of access.grants) {
        if (reachableLogins !== undefined && reachableLogins > 0) {
            const target = grant.selector.exact === undefined
                ? `the vault's ${JSON.stringify(grant.selector.category)} accounts`
                : `credential ${JSON.stringify(grant.selector.exact)}`;
            lines.push(`Confirmed ${grant.operation} access to ${target} (${reachableLogins} reachable ${reachableLogins === 1 ? 'login' : 'logins'}).`);
        }
        if (grantCommand)
            lines.push(`  ${grantCommand}`);
    }
    return lines;
}
