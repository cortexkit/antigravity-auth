/** Applicability is a plugin fact, never a substring match on a model id. */
export type Scope = {
    readonly kind: 'pool';
} | {
    readonly kind: 'family';
    readonly family: string;
} | {
    readonly kind: 'model';
    readonly model: string;
};
export type FamilyOf = (model: string) => string | undefined;
export declare function scopeCovers(scope: Scope, model: string, familyOf: FamilyOf): boolean;
