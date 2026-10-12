# AGY CLI 1.3.3 identity-free fixtures

`current-model-metadata.json` is the unchanged eighteen-route metadata projection
from the official CLI/model metadata capture (SHA-256
`8669774a72f404e5dba6b4d746b86d5ef313d7b234c72fad18d7e2166bb0af9d`).
`server-model-catalog.json` retains the separately captured 35-row server map
and its exact advertised model-ID lists. That map determines route availability;
the 18-row projection describes the CLI picker only. The server still offers
Gemini 3.5 Flash and Gemini 3.1 Flash Image. A declared Pro-high redirect is
server metadata, not permission for the adapter to rewrite the selected ID.

The native low files retain only field/order/configuration projections from the
Opus and Sonnet generation records, not complete requests. Original projection
hashes are `880d04375c0da4ae07c4ed0b851bfd401748dff1b479e9acaca8b1e0d68681c3`
and `ce9967fadf1cce17099123fe06f387768af3312ae9ddfcbbdcf884d407a46c13`.
Both observed native defaults were 128000 output tokens; only the forwarded
probe output cap changed to 2048. HTTP 200, OK and terminal STOP were observed
for each family. These records do not measure adapter implementation behavior.

The capture failed its stopping control: `writeTrajectoryAcls` was refused before
each generation, but the driver continued. No write was forwarded and only two
generations occurred. Acceptance of the observed fields does not make that a
compliant stopping-control run; no rerun is authorized.

`schema-derived-thinking.json` follows the public ThinkingConfig/ThinkingLevel
JSON schema (https://ai.google.dev/api/generate-content#ThinkingConfig, retrieved
2026-10-12). MEDIUM/HIGH are explicitly **not captured**. Numeric catalog efforts
are source metadata, not an assertion about Google's numeric protobuf enum.

Residuals: medium/high live encoding, tool continuations, varied SSE, complete
current wire/metadata parity, and relationships among first-turn step index and
extra cascade labels. Mocked request tests are not live AGY validation. Historical
1.1.24 fixtures remain separate controls.
