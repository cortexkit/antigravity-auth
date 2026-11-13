# Model Variants

OpenCode variants select the model's supported effort without adding a separate
picker entry for every tier. Use the plugin's current catalog rather than copying
an older model list into configuration.

The table lists the public picker models from the canonical [model registry](../../core/src/model-registry.ts). OpenCode exposes their IDs through `getAntigravityOpencodeModelIds()`.

| Model ID (under `google/`) | Variants | Quota |
| --- | --- | --- |
| `antigravity-gemini-4-hydrogen` | `low`, `medium`, `high` (default), `xhigh` | Gemini pool pending bucket evidence |
| `antigravity-gemini-4-carbon` | `low`, `medium` (default), `high` | Gemini pool until a Carbon quota bucket is observed |
| `antigravity-gemini-4-argon` | `low`, `medium` (default), `high` | Per-model readings; whether usage shares a weekly quota allowance with other models, and which allowance, is unverified |
| `antigravity-gemini-3.8-flash` | `low`, `medium`, `high` | `gemini-flash` |
| `antigravity-gemini-3.1-flash-image` | — | `gemini-flash` |
| `antigravity-claude-sonnet-5-5` | `low`, `medium`, `high` | `claude` |
| `antigravity-claude-opus-5-5` | `low`, `medium`, `high` | `claude` |
| `antigravity-gpt-oss-120b-medium` | — | `gpt-oss` |

The catalog uses a [model-list projection](../../../test-fixtures/agy-cli-1.3.5/server-model-catalog.json) of the official Antigravity CLI 1.3.5 `fetchAvailableModels` server response; see the [redacted capture's provenance](../../../test-fixtures/agy-cli-1.3.5/README.md). Carbon's three routes were added from the [CLI 1.5.5 server-map projection](../../../test-fixtures/agy-cli-1.5.5/carbon-model-metadata.json), read on November 10, 2026. Gemini 3.8 Flash Cyber is absent from that catalog and is not exposed. Gemini 3.5 Flash Lite is a helper route, not a public picker entry; Gemini 3.5 Flash Cyber remains restricted to the limited-access CodeMender pilot. Catalog presence does not prove live entitlement.

## Claude 5.5

Both `google/antigravity-claude-opus-5-5` and
`google/antigravity-claude-sonnet-5-5` support `low`, `medium` and `high` effort.
Their advertised limits are 1,000,000 context tokens and 128,000 output tokens.

```bash
opencode run "Hello" --model=google/antigravity-claude-opus-5-5 --variant=high
```

Claude 5.5 uses adaptive thinking, not the older token-budget variants. A model
configuration uses the supported effort names:

```json
{
  "antigravity-claude-opus-5-5": {
    "name": "Claude Opus 5.5",
    "limit": { "context": 1000000, "output": 128000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

Claude 4.6 routes are retired. They refuse requests and are not aliases for 5.5.
Update saved model selections explicitly; old `max` or custom thinking-budget
examples do not define a supported Claude 5.5 effort.

## Gemini

Gemini 4 Hydrogen requires Pro or Ultra in Google Antigravity and exposes low,
medium and high (default) on OpenCode 1, and low, medium, high (default) and xhigh
on OpenCode 2 and Pi. OpenCode 1 omits xhigh because its built-in Google library
(`@ai-sdk/google`) accepts only `minimal`/`low`/`medium`/`high` for `thinkingLevel`,
so xhigh would never reach the plugin. Its 1,048,576-token context follows
Google's 12 November announcement; the native CLI sends 262,144 output tokens,
with an explicit caller cap taking precedence. The [CLI 1.5.5 capture projection](../../../test-fixtures/agy-cli-1.5.5/hydrogen-evidence.json)
from 13 November observes `"LOW"` and the JSON number `100` for XHigh, without a
thinking budget or `toolConfig`. Low, high and xhigh were seen served in a live
probe on 13 November; medium's `"MEDIUM"` value is inferred from Gemini 4 Carbon's
thinking-level mapping.
Hydrogen stays on the ordinary Gemini quota pool.

The grouped `antigravity-gemini-3.8-flash`, `antigravity-gemini-4-argon` and
`antigravity-gemini-4-carbon` entries expose low, medium and high variants.
These selectors retain the
plugin's family-specific routing; do not infer a wire model or token budget solely
from the variant's display name.

Gemini 4 Carbon defaults to medium and advertises the same 1,048,576-token
context as Argon, with 262,144 output tokens; a caller's output cap still wins.
The [native CLI 1.5.5 Low capture](../../../test-fixtures/agy-cli-1.5.5/native-carbon-low.json)
observes `thinkingLevel: "LOW"`, `includeThoughts: true`, no thinking budget and
no `toolConfig`. MEDIUM/HIGH use the server-map enums and follow Argon's tier
mapping and toolConfig omission; those two efforts are inferred, not captured.
Carbon counts against the ordinary Gemini quota pool until a Carbon bucket is
observed; no Carbon-specific allowance is assumed.

Gemini 4 Argon requires **Google AI Ultra** and defaults to medium, matching the
official CLI. It sends an uppercase thinking level with no thinking budget and
defaults to 65,536 output tokens; a caller's output cap still wins. Only LOW is
captured on the wire; MEDIUM/HIGH follow catalog levels 2/3 in `test-fixtures/agy-cli-1.3.5/argon-model-metadata.json` and are unverified live.
The native LOW request omits toolConfig. The adapter applies that omission to the
whole Argon family; MEDIUM/HIGH omission remains unverified live.

Argon's remaining quota and reset time are reported per model. It is unverified whether Argon uses the same weekly quota allowance as other models, or which shared weekly allowance would apply.

Gemini 3.1 Pro, Gemini 3.5/3.6/3.7 Flash and `gemini-pro-agent` were withdrawn by
Antigravity. Grouped and native tier selectors refuse without aliases or
redirects. Use Gemini 3.8 Flash instead. Historical transcripts remain readable.
The Gemini 3.5 Flash routes left the server model map on November 6, 2026;
the helper routes `gemini-3-flash` and `gemini-3.5-flash-lite` are not retired.

```bash
opencode run "Hello" --model=google/antigravity-gemini-3.8-flash --variant=medium
```

## Explicit tier names

The resolver also accepts native tier-suffixed names, including
`antigravity-claude-opus-5-5-low`, `antigravity-claude-sonnet-5-5-high` and
`antigravity-gemini-3.8-flash-medium`. The grouped catalog entries with variants
are the normal picker interface.

The catalog uses the official CLI server model-list evidence linked above, with
subsequent withdrawals removed. An ID omitted from the CLI picker is not
necessarily retired: Gemini 3.1 Flash Image remains offered by the server.
Captured catalog data and low-effort Claude probes do not confirm the server
route and token budget for every model and effort.
