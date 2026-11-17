# Changelog

## Unreleased

### Added

- In vault mode, Pi applies the per-account model lists in `antigravity-auth.jsonc` (#67): a model the vault account's list leaves out is refused before anything is sent, and `/antigravity` → Accounts shows and sets each vault account's list. Pi's own login serves every model.

### Fixed

- While Pi uses the vault, it no longer keeps a copy of its own Google login, and any old saved copy is deleted. Leaving vault mode removes the vault marker and asks you to sign in again with `/login google`.
- Remove only the codemode clause from Pi's stock docs bullet in outgoing system prompts to avoid Antigravity's false quota refusal, preserving its other documentation pointers.
- Rewrite Pi and Pi-Bolt's stock system-prompt opener to the shorter coding-assistant identity accepted by Antigravity ([#76](https://github.com/cortexkit/antigravity-auth/issues/76)).

- Neutralise OpenCode and Pi harness self-identification only in outgoing system instructions so Google does not mistake the host's prompt for a quota failure. Unconfirmed request limits end with a clear error instead of encouraging host retries; OpenCode caps its own retries at two with a short model-specific cooldown.

- On Pi 0.86 and newer, requests now include the system prompt and tool declarations again. Pi now delivers them as system messages in the conversation, and the extension replays them with pi-ai's own helpers, including later prompt additions, section updates, and tool additions or removals. Older Pi versions keep working unchanged.
- Conversations without a Pi session ID no longer share Antigravity request metadata on Pi 0.86 and newer.
