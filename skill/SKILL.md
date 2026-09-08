---
name: storytok
description: Make StoryTok videos from the terminal — narrated Reddit story videos, texting-story videos, auto-captioned uploads, split-screen edits and AI highlight clips — and download the MP4. Use when the user asks for a TikTok/Reels/Shorts-style video, a Reddit story video, a "fake text" story, captions for a clip, or highlight clips from a long recording.
---

# StoryTok

StoryTok renders vertical (1080×1920, 30 fps) narrated and captioned videos. You write the script; StoryTok narrates it, times the captions word by word, lays it over gameplay footage and returns an MP4. Billing is per rendered minute (1 credit ≈ 1 minute, 2 with premium voices). Failed renders refund themselves.

Run everything through the CLI: `npx -y storytok-agent <command>` (Node 20+, no install step; the binary is called `storytok` if installed globally with `npm i -g storytok-agent`).

## Before anything else

1. **Auth.** If `STORYTOK_API_KEY` is not set and `npx -y storytok-agent account` fails with `no_api_key`, ask the user to run `npx -y storytok-agent login` in their own terminal (it waits up to 10 minutes for them to approve a code in the browser, longer than most tool timeouts) or to paste a key from https://storytok.ai/settings/developer into `STORYTOK_API_KEY`. The stored key is reused next time. A new account gets 3 free minutes.
2. **Catalog.** Run `npx -y storytok-agent catalog` once to see valid voice ids, caption presets, chat themes, background keys and music keys. Do not invent ids.
3. **Cost rule.** Every create command prints an estimate and then asks for confirmation. Never pass `--yes` until the user has seen the credits and agreed. In non-interactive shells the command exits with code 3 and the estimate; show the estimate, get a yes, then re-run with `--yes`.

## Commands

| Task | Command |
|---|---|
| Reddit story from a script | `npx -y storytok-agent story --title "…" --script-file story.txt --voice Joanna --background "Minecraft 4.mp4" --captions hormozi --intro --wait --out .` |
| Reddit story from a post URL | `npx -y storytok-agent story --reddit https://www.reddit.com/r/… --background "GTA 1.webm" --wait --out .` |
| Texting story | `npx -y storytok-agent text --contact Mom --messages convo.json --theme imessage_dark --background "Subway Surfers 2.mp4" --wait --out .` |
| Captions on an upload | `npx -y storytok-agent captions ./clip.mp4 --captions karaoke --wait --out .` |
| Split screen | `npx -y storytok-agent splitscreen ./clip.mp4 --background "Minecraft 1.mp4" --wait --out .` (or `--layout streamer --facecam 0.02,0.02,0.3,0.3`) |
| Highlight clips | `npx -y storytok-agent highlights ./podcast.mp4 --clips 3 --type key_insights --wait --out .` |
| Cost only | `npx -y storytok-agent estimate story --script-file story.txt --voice Joanna` |
| Status / wait / download | `npx -y storytok-agent job <id>`, `npx -y storytok-agent wait <id>`, `npx -y storytok-agent download <id> --out .` |

`--wait --out DIR` blocks until the render finishes (30–180 s; `--timeout 600` raises the default 240 s cap, and `wait <id>` resumes a wait that gave up) and saves the file. Always pass `--out` with the directory the user wants. Add `--json` for machine-readable output.

`convo.json` is `[{"side":"left","text":"are you awake","pause":"none"}, {"side":"right","text":"it's 3am. what","pause":"short"}]`. Left is the contact, right is "you". Use `--message "left: …" --message "right[long]: …"` for short conversations.

## Writing scripts that perform

- Reddit stories: first person, hook in the first sentence, 90–220 words (40–90 s), concrete details, one twist, end on the consequence. Never narrate a post verbatim; rewrite it as an original telling. Title ≤ 80 characters.
- Texting stories: 15–30 messages, each under 120 characters, lowercase texting voice; the reader should always be one message ahead of the reveal. Put `pause: "long"` before the two biggest reveals.
- Premium voices (marked `premium` in the catalog) sound better and cost 2× per minute; mention that when suggesting one.

## Errors you may see

- `insufficient_credits` / `402`: tell the user the shortfall and link `https://storytok.ai/pricing`. Do not retry.
- `too_many_active_jobs` / `429`: three renders are already running; wait for one, then retry.
- `daily_cap_reached` / `429`: this key's daily cap is used up; the user can raise it at `https://storytok.ai/settings/developer`.
- `idempotent_replay` in the output: identical inputs rendered recently and that job was returned instead of a new charge. Pass `--fresh` to force a new render.
- `request_in_progress` / `409`: the same request is still being created; wait a few seconds and re-run the same command.
- `idempotency_key_reused` / `422`: should not happen from the CLI; re-run with `--fresh`.
- `expired_token` / `410` during login: the code timed out or was already used; run `login` again.
- `timeout` or `network_error`: StoryTok did not answer; check `STORYTOK_API_URL` (default https://storytok.ai) and retry once.

Docs: https://storytok.ai/developers/agents
