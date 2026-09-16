# pi-env

[Pi](https://pi.dev/) extension that sets process environment variables from `settings.json` at startup.

Declare env vars declaratively in your pi settings instead of using shell wrappers or polluting your global shell environment.

**Why?**

- **Scoped to pi only** — variables are set inside the pi process without affecting your terminal session or other tools
- **Override existing vars** — set pi-specific values that take precedence over what's already in your shell (e.g. route a provider through a different endpoint without changing your global AWS config)
- **Declarative and portable** — commit project-level env config in `.pi/settings.json` for your team, keep personal values in global settings

## Installation

```bash
pi install npm:pi-env
```

Or from git:

```bash
pi install https://github.com/lucascajal/pi-env
```

## Usage

Add an `"env"` key to your global or project settings:

**`~/.pi/agent/settings.json`** (global) or **`.pi/settings.json`** (project):

```json
{
  "env": {
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME": "https://my.corp.proxy/bedrock",
    "AWS_BEARER_TOKEN_BEDROCK": "$MY_CORP_TOKEN",
    "AWS_BEDROCK_FORCE_HTTP1": "1",
    "GOOGLE_CLOUD_PROJECT": "my-project",
    "GOOGLE_CLOUD_LOCATION": "us-central1"
  }
}
```

Environment variables are set before providers initialize, so they're available when pi makes API requests.

Note that if environment variables are used by other extensions make sure to load pi-env before them in `settings.json`. 

## Variable interpolation

Reference pre-existing environment variables using pi's value resolution syntax:

| Syntax | Meaning |
|--------|---------|
| `$ENV_VAR` | Value of `ENV_VAR` from the shell environment |
| `${ENV_VAR}` | Same, braced form (useful when followed by text) |
| `!ENV_CMD` | Output of `ENV_CMD` when executed in the shell environment (global settings only, see below) |
| `$$` | Literal `$` character |
| `literal` | Used as-is |

**`!ENV_CMD` is only honored in global settings** (`~/.pi/agent/settings.json`). Project settings (`.pi/settings.json`) ship inside repositories, so a `!command` value there is not trusted or executed — it is reported as a blocked warning instead.

Project settings are only applied after pi's [project trust](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/security.md) prompt has been accepted for the folder. Until then only global settings are applied, so a cloned repo cannot set variables like `PATH`, `NODE_OPTIONS`, or `ANTHROPIC_BASE_URL` in the agent process before you approve it.

Even in a trusted project, project settings may not set loader, shell-startup, or network-redirect variables (`PATH`, `NODE_OPTIONS`, `LD_*`/`DYLD_*`, `BASH_ENV`, `GIT_SSH_COMMAND`, `*_PROXY`, `*_BASE_URL`, `*_ENDPOINT_URL*`, TLS overrides, and a few more). They are skipped and reported as refused. Put those in global settings instead.

```json
{
  "env": {
    "API_URL": "https://${REGION}.api.example.com/v1",
    "AUTH_TOKEN": "$VAULT_TOKEN",
    "TEST_TOKEN": "!openssl rand -hex 32",
    "PRICE": "$$9.99"
  }
}
```

## Settings hierarchy

Honors pi's settings merge behavior:

1. **Global** (`~/.pi/agent/settings.json`) — base defaults
2. **Project** (`.pi/settings.json`) — overrides global per-key

If both define `env`, the project values override global values for the same keys. Unique keys from both levels are merged.

## Features

- **Scalar coercion** — numbers and booleans are coerced to strings via `String()`
- **Stale cleanup** — variables removed from settings are unset on `/reload`
- **`/env` command** — print currently configured env var names in the TUI at any time (values are masked, since the output is persisted in the session file)
- **Styled output** — shows a summary of applied variables on session start
- **Warnings** — notifies in the TUI for unresolved variables, non-scalar values, overridden existing env vars, or blocked `!command` execution from project settings

## Why not just export in .zshrc?

Shell exports apply to every process. With `pi-env`, you can:

- Set `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` for pi without affecting your AWS CLI
- Override `AWS_REGION` per-project without changing your shell profile
- Keep provider routing config versioned with the project
- Avoid wrapper functions like `pi() { VAR=x command pi "$@"; }`
- Use a secrets manager for environment variables

## License

MIT
