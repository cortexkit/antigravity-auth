# agy CLI 1.5.8 identity projection

`identity-projection.json` is the unchanged redacted projection captured on
2026-11-13 with agy print mode through client-side mitmproxy 11.0.2. Generations
were forwarded untouched without an output cap. Text is omitted and UUID tokens
describe shape, not equality. The capture includes Gemini and Claude tool
continuations, model switches, and session-ID checks. Tests separately assert
the verified ID relationships because the redaction does not preserve them.

## Additional live captures

On the same day, the operator captured every remaining Flash 3.8, Sonnet 5.5
and Opus 5.5 tier with agy 1.5.8. Every request returned HTTP 200 and sent no
`thinkingBudget` or `toolConfig`. These rows supplement the unchanged projection;
they are captured values, not inferred family mappings.

| Model | maxOutputTokens | thinkingConfig |
| --- | ---: | --- |
| gemini-3.8-flash-medium | 65536 | `{includeThoughts: true, thinkingLevel: "MEDIUM"}` |
| gemini-3.8-flash-high | 65536 | `{includeThoughts: true, thinkingLevel: "HIGH"}` |
| claude-sonnet-5-5-medium | 128000 | `{includeThoughts: true, thinkingLevel: "MEDIUM"}` |
| claude-sonnet-5-5-high | 128000 | `{includeThoughts: true, thinkingLevel: "HIGH"}` |
| claude-opus-5-5-low | 128000 | `{includeThoughts: true, thinkingLevel: "LOW"}` |
| claude-opus-5-5-medium | 128000 | `{includeThoughts: true, thinkingLevel: "MEDIUM"}` |
| claude-opus-5-5-high | 128000 | `{includeThoughts: true, thinkingLevel: "HIGH"}` |
