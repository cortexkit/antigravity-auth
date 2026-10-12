export class OpenCode2AuthError extends Error {
    kind;
    providerID;
    sessionID;
    requestKind;
    constructor(details) {
        super(details.message ??
            `${details.providerID} ${details.requestKind} request refused (${details.kind})`);
        this.name = 'OpenCode2AuthError';
        this.kind = details.kind;
        this.providerID = details.providerID;
        this.sessionID = details.sessionID;
        this.requestKind = details.requestKind;
    }
}
