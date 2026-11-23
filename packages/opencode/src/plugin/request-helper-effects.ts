import {
  filterMessagesThinkingBlocks as filterMessages,
  deepFilterThinkingBlocks as filterThinkingDeep,
  filterUnsignedThinkingBlocks as filterUnsigned,
  fixToolResponseGrouping as groupToolReplies,
  createNativeGoogleErrorResponse as nativeErrorResponse,
  recursivelyParseJsonStrings as parseJsonStrings,
  transformThinkingParts as transformThinking,
} from '@cortexkit/antigravity-auth-core/engine'
import { getKeepThinking } from './config'
import { processImageData } from './image-saver'
import { createLogger } from './logger'

export const AUTH_COMMAND = 'opencode auth login'
export const requestHelperLog = createLogger('request-helpers')

type FilterArgs =
  Parameters<typeof filterUnsigned> extends [unknown, ...infer Rest]
    ? Rest
    : never

function bindThinkingFilter<Input, Output>(
  filter: (input: Input, ...args: FilterArgs) => Output,
) {
  return (
    input: Input,
    sessionId?: string,
    getCachedSignature?: FilterArgs[1],
    isClaude?: boolean,
    keepThinking = getKeepThinking(),
  ) =>
    filter(
      input,
      sessionId,
      getCachedSignature,
      isClaude,
      keepThinking,
      requestHelperLog,
    )
}

export const filterUnsignedThinkingBlocks = bindThinkingFilter(filterUnsigned)
export const filterMessagesThinkingBlocks = bindThinkingFilter(filterMessages)
export const deepFilterThinkingBlocks = bindThinkingFilter(filterThinkingDeep)

export function transformThinkingParts(response: unknown): unknown {
  return transformThinking(response, processImageData, requestHelperLog)
}

export function fixToolResponseGrouping(contents: any[]): any[] {
  return groupToolReplies(contents, requestHelperLog)
}

export function recursivelyParseJsonStrings(
  obj: unknown,
  keys?: Set<string>,
  key?: string,
): unknown {
  return parseJsonStrings(obj, keys, key, requestHelperLog)
}

export function createNativeGoogleErrorResponse(
  options: Parameters<typeof nativeErrorResponse>[0],
): Response {
  return nativeErrorResponse(options, AUTH_COMMAND)
}
