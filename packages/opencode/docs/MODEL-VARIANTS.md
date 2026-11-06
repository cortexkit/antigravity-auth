# Model Variants

OpenCode variants select the model's supported effort without adding a separate
picker entry for every tier. Use the plugin's current catalog rather than copying
an older model list into configuration.

The table lists the public picker models from the canonical [model registry](../../core/src/model-registry.ts). OpenCode exposes their IDs through `getAntigravityOpencodeModelIds()`.

| Model ID (under `google/`) | Variants | Quota |
| --- | --- | --- |
| `antigravity-gemini-4-argon` | `low`, `medium` (default), `high` | Per-model readings; whether usage shares a weekly quota allowance with other models, and which allowance, is unverified |
| `antigravity-gemini-3.8-flash` | `low`, `medium`, `high` | `gemini-flash` |
| `antigravity-gemini-3.1-flash-image` | — | `gemini-flash` |
| `antigravity-claude-sonnet-5-5` | `low`, `medium`, `high` | `claude` |
| `antigravity-claude-opus-5-5` | `low`, `medium`, `high` | `claude` |
| `antigravity-gpt-oss-120b-medium` | — | `gpt-oss` |

The catalog uses a [model-list projection](../../../test-fixtures/agy-cli-1.3.5/server-model-catalog.json) of the official Antigravity CLI 1.3.5 `fetchAvailableModels` server response; see the [redacted capture's provenance](../../../test-fixtures/agy-cli-1.3.5/README.md). Gemini 3.8 Flash Cyber is absent from that catalog and is not exposed. Gemini 3.5 Flash Lite is a helper route, not a public picker entry; Gemini 3.5 Flash Cyber remains restricted to the limited-access CodeMender pilot. Catalog presence does not prove live entitlement.

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

The grouped `antigravity-gemini-3.8-flash` and
`antigravity-gemini-4-argon` entries expose low, medium and high variants.
These selectors retain the
plugin's family-specific routing; do not infer a wire model or token budget solely
from the variant's display name.

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
