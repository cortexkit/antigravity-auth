export function canonicalModelId(id: string): string {
  return id
}

export function compileModelAccess(
  _accountModels: unknown,
  _options?: { unusable?: boolean; lastApplied?: unknown },
) {
  return {
    valid: true,
    issues: [] as { accountKey?: string; modelId?: string; reason: string }[],
    allows: (_accountKey: string | undefined, _requestModel: string): boolean =>
      true,
  }
}
