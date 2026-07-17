# @cortexkit/pi-antigravity-auth

Google Antigravity OAuth extension for [pi](https://github.com/earendil-works/pi-mono).
Authenticate with your Google account and use Gemini 3 models through
Antigravity's endpoints.

> [!CAUTION]
> Using this extension violates Google's Terms of Service. Accounts may be
> suspended or banned. This is an unofficial tool not endorsed by Google.

## Install

```bash
pi install npm:@cortexkit/pi-antigravity-auth
```

## Login

```
/login google-antigravity
```

A browser URL is shown. Complete the Google OAuth flow and paste the resulting
callback URL (or authorization code) back into the prompt.

## Models

The extension registers the Antigravity model catalog under the
`google-antigravity` provider, including:

- `antigravity-gemini-3.5-flash`
- `antigravity-gemini-3.1-pro`
- `antigravity-claude-sonnet-4-6-thinking`
- `antigravity-claude-opus-4-6-thinking`
- `antigravity-gpt-oss-120b-medium`

The image-generation model is currently OpenCode-only because Pi's provider event
protocol does not expose image-output stream events.

Select a model with `/model` or `pi -m google-antigravity/antigravity-gemini-3.5-flash`.

## Configuration

| Environment variable | Description |
| --- | --- |
| `PI_AGENT_DIR` | Override the pi agent directory (default `~/.pi/agent`). |
| `PI_ANTIGRAVITY_AUTH_FILE` | Override the account storage file path. |

## Notes

This package shares its transport, OAuth, fingerprint, and request-transform
logic with the OpenCode plugin via
[`@cortexkit/antigravity-auth-core`](../core). The current pi release targets a
single authenticated account; multi-account rotation and quota gating are
provided by the OpenCode plugin and are planned for pi in a later release.

## License

MIT
