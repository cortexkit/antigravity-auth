# Changelog

## Unreleased

## [3.2.0] - 2026-11-24

### Added

- Pi reads supported request settings from the user `antigravity-auth.jsonc` file. For example, `keep_thinking` can preserve Claude's thinking across turns; OpenCode's account rotation and quota controls do not apply.
- The thinking picker offers XHigh for Gemini 4 Neon and Hydrogen and no adjustable levels for fixed-tier GPT-OSS.

### Fixed

- Pasted Google sign-in links must match the sign-in you started. Pasting just the authorization code still works.
- When Gemini ends a response with a malformed tool call before any reply text, the request is sent once more instead of failing (#79).
- Tool arguments and results with an object named `thinking` are sent intact (#81).
- User and assistant messages that start with thinking or debug marker text are no longer replaced by a period (#82).
- Pi uses the same Antigravity request engine as OpenCode, including endpoint fallback, bounded retries, tool history and thinking replay. It still uses only one account and leaves the native Google login in place when reauthorization is needed.
- An unrecognized Google stop reason is shown as `unknown`. Refusals no longer expose raw Google diagnostics or cause Pi to resend the request.
- A local login or token refresh in progress stops without replacing the login if the credential source changes.
- Removed every Antigravity image-generation model; Pi never offered image output, and attaching images to a prompt still works.
- Pi now honors `failure_ttl_seconds` for how long it remembers a failed request before trying the account again.
- Refusals now name their cause with fixed text, such as Google suspending Antigravity access for the account or asking you to slow down, and never cause Pi to resend.

## Earlier releases

These changes shipped in 3.1.13 and earlier.

- In vault mode, Pi applies the per-account model lists in `antigravity-auth.jsonc` (#67): a model the vault account's list leaves out is refused before anything is sent, and `/antigravity` → Accounts shows and sets each vault account's list. Pi's own login serves every model.
- Responses that Google stops for safety or another refusal now show an error instead of appearing to complete successfully.
- Pi can resume Antigravity conversations that end with an assistant reply, while normal Gemini tool continuations stay unchanged.
- A model response that stalls, is aborted, is cancelled or is cut off before its end now fails with an error and closes its connection, instead of hanging or being passed on as a complete answer.
- While Pi uses the vault, it no longer keeps a copy of its own Google login, and any old saved copy is deleted. Leaving vault mode removes the vault marker and asks you to sign in again with `/login google`.
- Remove only the codemode clause from Pi's stock docs bullet in outgoing system prompts to avoid Antigravity's false quota refusal, preserving its other documentation pointers.
- Rewrite Pi and Pi-Bolt's stock system-prompt opener to the shorter coding-assistant identity accepted by Antigravity ([#76](https://github.com/cortexkit/antigravity-auth/issues/76)).

- Neutralise OpenCode and Pi harness self-identification only in outgoing system instructions so Google does not mistake the host's prompt for a quota failure. Unconfirmed request limits end with a clear error instead of encouraging host retries; OpenCode caps its own retries at two with a short model-specific cooldown.

- On Pi 0.86 and newer, requests now include the system prompt and tool declarations again. Pi now delivers them as system messages in the conversation, and the extension replays them with pi-ai's own helpers, including later prompt additions, section updates, and tool additions or removals. Older Pi versions keep working unchanged.
- Conversations without a Pi session ID no longer share Antigravity request metadata on Pi 0.86 and newer.
