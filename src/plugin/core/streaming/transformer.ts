import type {
  SignatureStore,
  StreamingCallbacks,
  StreamingOptions,
  ThoughtBuffer,
} from './types';
import { processImageData } from '../../image-saver';

/**
 * Simple string hash for thinking deduplication.
 * Uses DJB2-like algorithm.
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); /* hash * 33 + c */
  }
  return (hash >>> 0).toString(16);
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => buffer.set(index, text),
    clear: () => buffer.clear(),
  };
}

export function transformStreamingPayload(
  payload: string,
  transformThinkingParts?: (response: unknown) => unknown,
): string {
  return payload
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          const transformed = transformThinkingParts
            ? transformThinkingParts(parsed.response)
            : parsed.response;
          return `data: ${JSON.stringify(transformed)}`;
        }
      } catch (_) {}
      return line;
    })
    .join('\n');
}

export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== 'object') return response;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return candidate;

      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return candidate;

      const newParts = content.parts.map((part: unknown) => {
        const p = part as Record<string, unknown>;
        
        // Handle image data - save to disk and return file path
        if (p.inlineData) {
          const inlineData = p.inlineData as Record<string, unknown>;
          const result = processImageData({
            mimeType: inlineData.mimeType as string | undefined,
            data: inlineData.data as string | undefined,
          });
          if (result) {
            return { text: result };
          }
        }
        
        if (p.thought === true || p.type === 'thinking') {
          const fullText = typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : "";
          
          if (displayedThinkingHashes) {
            const hash = hashString(fullText);
            if (displayedThinkingHashes.has(hash)) {
              sentBuffer.set(index, fullText);
              // Sentinel instead of null — preserves array length on response path
              return { text: "" };
            }
            displayedThinkingHashes.add(hash);
          }

          const sentText = sentBuffer.get(index) ?? '';

          if (fullText.startsWith(sentText)) {
            const delta = fullText.slice(sentText.length);
            sentBuffer.set(index, fullText);

            if (delta) {
              // Clean object — NO spread to prevent thinking: <object> leaking
              return { thought: true, text: delta };
            }
            // Sentinel instead of null — preserves array length on response path
            return { text: "" };
          }

          sentBuffer.set(index, fullText);
          return part;
        }        return part;
      });

      return {
        ...cand,
        content: { ...content, parts: newParts },
      };    });

    return { ...resp, candidates: newCandidates };
  }

  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const fullText = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        
        if (displayedThinkingHashes) {
          const hash = hashString(fullText);
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText);
            thinkingIndex++;
            // Sentinel instead of null — preserves array length on response path
            return { type: "text", text: "" };
          }
          displayedThinkingHashes.add(hash);
        }

        const sentText = sentBuffer.get(thinkingIndex) ?? '';

        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length);
          sentBuffer.set(thinkingIndex, fullText);
          thinkingIndex++;

          if (delta) {
            // Clean object — NO spread to prevent thinking: <object> leaking
            return { type: b.type, thinking: delta, text: delta };
          }
          // Sentinel instead of null — preserves array length on response path
          return { type: "text", text: "" };
        }

        sentBuffer.set(thinkingIndex, fullText);
        thinkingIndex++;
        return block;
      }      return block;
    });

    return { ...resp, content: newContent };  }

  return response;
}

export function transformSseLine(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
): string {
  if (!line.startsWith('data:')) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }

  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        );
      }

      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );

      if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState.injected = true;
      }
      // Note: onInjectSyntheticThinking removed - keep_thinking now uses debugText path

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response;
      return `data: ${JSON.stringify(transformed)}`;
    }
  } catch (_) {}
  return line;
}

export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void,
): void {
  if (!response || typeof response !== 'object') return;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return;
      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return;

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.thought === true || p.type === 'thinking') {
          const text = typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : "";
          if (text) {
            const current = thoughtBuffer.get(index) ?? '';
            thoughtBuffer.set(index, current + text);
          }
        }
        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? '';
          if (fullText) {
            const signature = p.thoughtSignature as string;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, { text: fullText, signature });
          }
        }
      });
    });
  }

  if (Array.isArray(resp.content)) {
    // Use thoughtBuffer to accumulate thinking text across SSE events
    // Claude streams thinking content and signature in separate events
    const CLAUDE_BUFFER_KEY = 0; // Use index 0 for Claude's single-stream content
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const text = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
        if (fullText) {
          const signature = b.signature as string;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}

export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState = { injected: false };
  let hasSeenUsageMetadata = false;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Quick check for usage metadata presence in the raw line
        if (line.includes('usageMetadata')) {
          hasSeenUsageMetadata = true;
        }

        const transformedLine = transformSseLine(
          line,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine + '\n'));
      }
    },
    flush(controller) {
      buffer += decoder.decode();

      if (buffer) {
        if (buffer.includes('usageMetadata')) {
          hasSeenUsageMetadata = true;
        }
        const transformedLine = transformSseLine(
          buffer,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine));
      }

      // Inject synthetic usage metadata if missing (fixes "Context % used: 0%" issue)
      if (!hasSeenUsageMetadata) {
        const syntheticUsage = {
          response: {
            usageMetadata: {
              promptTokenCount: 0,
              candidatesTokenCount: 0,
              totalTokenCount: 0,
            }
          }
        };
        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(syntheticUsage)}\n\n`));
      }
    },
  });
}
