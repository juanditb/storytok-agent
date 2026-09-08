# storytok

Make [StoryTok](https://storytok.ai) videos from any coding agent or shell: narrated Reddit story videos, texting-story videos, auto captions, split-screen edits and AI highlight clips, as 1080×1920 MP4s. One package, three ways in:

- **CLI**: `npx -y storytok story --reddit <url> --background "GTA 1.webm" --wait --out .`
- **MCP server**: `npx -y storytok mcp` for Claude Code, Claude Desktop, Cursor, Windsurf, Codex and any MCP client.
- **Skill**: `skill/SKILL.md` teaches agents without MCP how to use the CLI.

Billing is StoryTok's: 1 credit per rendered minute (2 with premium voices), from packs that never expire, 3 free minutes on every new account. Failed renders refund automatically. There is no subscription and nothing to cancel.

## Install

**Claude Code**

```sh
claude mcp add storytok -e STORYTOK_API_KEY=stk_live_… -- npx -y storytok mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.storytok]
command = "npx"
args = ["-y", "storytok", "mcp"]
env = { STORYTOK_API_KEY = "stk_live_…" }
```

**Cursor / Windsurf / Claude Desktop** (`mcp.json`)

```json
{ "mcpServers": { "storytok": { "command": "npx", "args": ["-y", "storytok", "mcp"], "env": { "STORYTOK_API_KEY": "stk_live_…" } } } }
```

Get a key at [storytok.ai/settings/developer](https://storytok.ai/settings/developer), or skip the copying: run `npx -y storytok login`, approve the code in your browser, and the key is stored in `~/.config/storytok/config.json`.

## What the agent can do

| Tool | What it does |
|---|---|
| `get_account`, `get_catalog` | Balance and cap; valid voices, caption presets, chat themes, backgrounds, music |
| `import_reddit_post` | A Reddit URL → title, script, intro-card stats |
| `create_story_video` | Narrated story over gameplay, optional Reddit intro card |
| `create_texting_story` | Chat bubbles revealed one by one, a voice per side |
| `create_captions_video` | Upload a local video, burn word-timed captions |
| `create_splitscreen_video` | Classic gameplay split or streamer facecam layout |
| `create_highlights` | 1–20 AI-picked clips, scored, with hook lines |
| `get_job`, `wait_for_job`, `download_job`, `list_jobs` | Poll, block until done, save the MP4 (or clips + zip) |

Every creating tool is two-phase: called without `confirm` it returns the cost estimate; the agent shows it, the user agrees, and only then does it render. Job creation sends an `Idempotency-Key`, so a retried call returns the same job instead of a second charge. Each key also has a rolling 24-hour credit cap (30 by default, editable in settings).

## CLI

```
storytok login | logout | account | catalog | estimate | reddit
storytok story | text | captions | splitscreen | highlights
storytok job <id> | wait <id> | download <id> | jobs
storytok mcp
```

`storytok --help` lists every flag. Set `STORYTOK_API_URL` to point at another deployment.

## Development

```sh
npm install
npm test          # unit tests against a mock API, plus an MCP round trip over stdio
node bin/storytok.js --help
```

MIT licensed. Issues and pull requests welcome.
