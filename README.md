# openbee Claude Code engine

An [openbee](https://github.com/theopenbee/openbee) engine plugin that runs tasks with [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code). It is built on [`@theopenbee/engine-sdk`](https://www.npmjs.com/package/@theopenbee/engine-sdk).

## Requirements

You install Claude Code and log in to it yourself. The plugin only starts it.

```sh
npm i -g @anthropic-ai/claude-code
claude
```

Run `claude` once and sign in, or give Claude Code an API key as an environment variable in openbee's **Env** settings (for example `ANTHROPIC_API_KEY`). openbee passes its environment, including these settings, to Claude Code.

The plugin itself needs Node.js 20 or newer (or Bun).

## Install

```sh
openbee plugin install claude
```

Or from npm by package name:

```sh
openbee plugin install @theopenbee/engine-claude
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/engine-claude.git
cd engine-claude
npm install
openbee plugin install "$(pwd)"
```

Then enable the plugin, and pick `claude` as the default engine or per worker.

## Settings

| Setting | Description |
|---|---|
| `path` | Path to the `claude` executable. Leave empty to use `claude` from `PATH`. |

The plugin checks the setting when it is enabled: it runs `claude --version` and shows the version, or the reason it failed (for example `claude not found on PATH`).

## Sessions

Sessions stay in Claude Code's own config directory, `~/.claude/projects/` (or `~/.config/claude/projects/`). The plugin does not copy or move them, so conversations that were started before the plugin was installed resume as before, and they survive uninstalling the plugin.

Token usage is read from the same session files and summed per model. If `CLAUDE_CONFIG_DIR` is set in openbee's environment, only the directories it lists (comma separated) are searched instead of the two defaults. Before a resume, the whole value is also tried as one directory, so a config directory whose path contains a comma is found.

## How it runs Claude Code

```
claude --dangerously-skip-permissions --verbose --output-format stream-json [--mcp-config=<json>] [--session-id <id> | --resume <id>] [extra args] --print
```

- The prompt is written to Claude Code's standard input.
- When openbee provides its MCP server, the plugin passes `--mcp-config` with an HTTP server entry that sends `Authorization: Bearer ${OPENBEE_API_KEY}`. The placeholder is expanded by Claude Code from its environment, so the API key never appears on the command line.
- A new conversation starts with `--session-id`; later turns use `--resume` when Claude Code's session file for that id exists. If the file is missing, for example because the first run failed before Claude Code created it, the plugin starts the conversation again with `--session-id` instead of failing every later message.
- Auto-update is disabled for runs started by openbee (`DISABLE_AUTOUPDATER=1`).
- The result is the text of the final `result` event, or the last assistant text when there is none. A non-zero exit code or an `is_error` result is reported as a failed run, with Claude Code's own message when it gave one.
- Claude Code's output is written to the run's log file as it arrives.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The end-to-end tests run the plugin against a fake `claude` script, under Node and under Bun when it is installed (`bun` on `PATH` or `~/.openbee/runtime/bun-*/bun`).

## License

MIT
