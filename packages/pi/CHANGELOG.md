# Changelog

## Unreleased

### Fixed

- On Pi 0.86 and newer, requests now include the system prompt and tool declarations again. Pi now delivers them as system messages in the conversation, and the extension replays them with pi-ai's own helpers, including later prompt additions, section updates, and tool additions or removals. Older Pi versions keep working unchanged.
- Conversations without a Pi session ID no longer share Antigravity request metadata on Pi 0.86 and newer.
