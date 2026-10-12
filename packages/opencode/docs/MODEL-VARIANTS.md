# Model Variants

OpenCode variants select the model's supported effort without adding a separate
picker entry for every tier. Use the plugin's current catalog rather than copying
an older model list into configuration.

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

The grouped `antigravity-gemini-3.5-flash`, `3.6-flash`, `3.7-flash` and
`3.8-flash` entries expose low, medium and high variants.
`antigravity-gemini-3.1-pro` exposes low and high. These selectors retain the
plugin's family-specific routing; do not infer a wire model or token budget solely
from the variant's display name.

```bash
opencode run "Hello" --model=google/antigravity-gemini-3.8-flash --variant=medium
```

## Explicit tier names

The resolver also accepts native tier-suffixed names, including
`antigravity-claude-opus-5-5-low`, `antigravity-claude-sonnet-5-5-high` and
`antigravity-gemini-3.8-flash-medium`. The grouped catalog entries with variants
are the normal picker interface.

The current catalog comes from the captured Antigravity server map. An ID omitted
from the CLI picker is not necessarily retired: Gemini 3.5 Flash and Gemini 3.1
Flash Image remain offered by the server. Captured catalog data and low-effort
Claude probes do not establish complete wire parity for every model and effort.
