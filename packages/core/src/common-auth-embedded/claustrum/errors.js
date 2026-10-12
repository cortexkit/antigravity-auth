export class ClaustrumConsumerError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = 'ClaustrumConsumerError';
        this.kind = kind;
    }
}
