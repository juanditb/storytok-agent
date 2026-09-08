// `storytok` command line. Plain argv parsing, no dependencies. Every
// creating command estimates first and asks before spending; `--yes` skips
// the question for scripts and agents that already confirmed with the user.

import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import {
  StoryTokClient,
  StoryTokError,
  VERSION,
  buildCaptionsJob,
  buildHighlightsJob,
  buildSplitscreenJob,
  buildStoryJob,
  buildTextingJob,
  estimateInputFor,
  formatCredits,
  formatMinutes,
  newIdempotencyKey,
  probeDurationSeconds,
  defaultDownloadDir,
  readConfig,
  resolveApiKey,
  siteUrl,
  writeConfig,
} from "./core.js"

const HELP = `storytok ${VERSION} — make StoryTok videos from the terminal or any coding agent

Usage: storytok <command> [options]

  login [--client <name>]         Connect this machine to your StoryTok account (prints a code + link to approve; --timeout S)
  logout                          Forget the stored key
  account                         Balance, trial credits, daily cap
  catalog [--voices|--backgrounds|--presets|--themes|--types|--music]
  estimate <format> [inputs]      Credits a render would reserve (same inputs as the create commands)

  story      --title T --script S | --script-file F | --script - (stdin) | --reddit URL
             [--voice V --speed 1.2 --background B --captions P --intro --intro-username U --intro-upvotes N --intro-comments N --music K --bars blur|black]
  text       --contact NAME --messages FILE.json | --message "left: hi" --message "right: hey" [--theme T --left-voice V --right-voice V --no-narration --no-sfx --background B --music K]
  captions   <video> [--captions P --trim 0:10-1:30 --bars blur|black --music K]
  splitscreen <video> --background B | --layout streamer [--facecam x,y,w,h] [--captions P]
  highlights <video> [--clips 3 --type engaging_content --style subtitles|splitscreen --backgrounds A,B --length 30 --fixed-length]

  job <id> [--wait]               Status, or block until finished
  wait <id> [--timeout 240]       Block until finished, then print the result
  estimate captions|splitscreen|highlights --seconds N   Cost for a source of N seconds without a file
  download <id> [--out DIR]       Save the MP4 (or clips + zip)
  jobs [--limit 20 --status S --type T]
  reddit <url>                    Read a Reddit post into title + script
  mcp                             Run the MCP server over stdio (for Claude Code, Cursor, Codex …)

Common flags: --yes (skip the cost confirmation), --wait (block until rendered), --out DIR (download when done), --json (machine output), --fresh (force a new render of identical inputs)
Keys: STORYTOK_API_KEY env var or \`storytok login\`. Docs: ${siteUrl()}/developers/agents`

/** Flags that never take a value, so `--wait ./clip.mp4` keeps the file as a positional. */
const BOOLEAN_FLAGS = new Set(["yes", "wait", "json", "fresh", "intro", "fixedLength", "help", "version", "narration", "sfx"])
/** Flags that may repeat (collected into arrays). Any other repeated flag is an error. */
const LIST_FLAGS = new Set(["message"])

export function parseArgs(argv) {
  const args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === "--") {
      args._.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s)
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (inlineValue !== undefined) {
        push(args.flags, key, inlineValue)
      } else if (rawKey.startsWith("no-")) {
        args.flags[rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false
      } else if (BOOLEAN_FLAGS.has(key)) {
        args.flags[key] = true
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        push(args.flags, key, argv[i + 1])
        i += 1
      } else {
        args.flags[key] = true
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function push(flags, key, value) {
  if (key in flags && !LIST_FLAGS.has(key)) {
    throw new StoryTokError(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} was given more than once.`, { code: "invalid_input" })
  }
  if (key in flags) {
    flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value]
  } else {
    flags[key] = value
  }
}

function asNumber(value, fallback) {
  if (value === undefined || value === true) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseTrim(value) {
  if (!value || value === true) return undefined
  const [start, end] = String(value).split("-")
  return { start: clock(start), end: clock(end) }
}

function clock(value) {
  if (!value) return undefined
  const parts = value.split(":").map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function print(value) {
  output.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`)
}

async function confirm(question) {
  if (!input.isTTY) return false
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

function describeEstimate(estimate) {
  const bits = [`≈ ${formatMinutes(estimate.estimated_minutes)} of video`, `${formatCredits(estimate.credits_required)}${estimate.premium_voice ? " (premium voice, 2×)" : ""}`]
  bits.push(`balance ${estimate.balance}`)
  if (estimate.shortfall > 0) bits.push(`short by ${estimate.shortfall}`)
  return bits.join(" · ")
}

/**
 * Shared create flow: estimate → confirm (unless --yes) → create → optional
 * wait/download. Returns the API response.
 */
async function createFlow(client, payload, { flags, durationSeconds, json }) {
  const estimateInput = estimateInputFor(payload, { durationSeconds })
  let estimate = null
  if (estimateInput) {
    estimate = (await client.estimate(estimateInput)).estimate
    if (!json) print(`Estimate: ${describeEstimate(estimate)}`)
    if (estimate.shortfall > 0) {
      throw new StoryTokError(`Not enough credits: need ${estimate.credits_required}, have ${estimate.balance}. Add a pack at ${siteUrl()}/pricing`, { code: "insufficient_credits" })
    }
  } else if (!json) {
    print("Estimate: 1 credit reserved now; settled on the source's real length after upload.")
  }

  if (!flags.yes) {
    const ok = await confirm(`Render it${estimate ? ` for ${formatCredits(estimate.credits_required)}` : ""}?`)
    if (!ok) {
      throw new StoryTokError("Not rendered. Re-run with --yes once the user has agreed to the cost.", { code: "not_confirmed" })
    }
  }

  const created = await client.createJob(payload, { idempotencyKey: flags.fresh ? newIdempotencyKey() : undefined })
  if (created.idempotent_replay && !json) print("Same inputs as a recent render; returning that job instead of rendering again (use --fresh to force).")
  let result = created
  if (flags.wait || flags.out) {
    if (!json) print(`Queued ${created.job.id}. Waiting…`)
    result = await client.waitForJob(created.job.id, {
      timeoutS: asNumber(flags.timeout, 240),
      onProgress: (job) => {
        if (!json) output.write(`  ${job.status} ${job.progress ?? 0}% ${job.stage ?? ""}\n`)
      },
    })
    if (result.job.status !== "completed") {
      throw new StoryTokError(`Job ${result.job.status}: ${result.job.failure_message ?? "no details"}`, { code: "job_failed" })
    }
    if (flags.out) {
      const saved = await client.download(created.job.id, flags.out === true ? defaultDownloadDir() : flags.out)
      result.files = saved.files
      if (!json) for (const file of saved.files) print(`Saved ${file}`)
    }
  }
  return result
}

/**
 * The script comes from --script, --script-file, or stdin when `--script -`
 * is passed. Stdin is never read implicitly: agent harnesses hand child
 * processes an open pipe, and a silent read would hang until it closes.
 */
async function readScript(flags) {
  if (flags.script === "-") {
    const chunks = []
    for await (const chunk of input) chunks.push(chunk)
    return Buffer.concat(chunks).toString("utf8").trim() || null
  }
  if (flags.script && flags.script !== true) return String(flags.script)
  if (flags.scriptFile && flags.scriptFile !== true) {
    try {
      return (await readFile(flags.scriptFile, "utf8")).trim()
    } catch (cause) {
      throw new StoryTokError(`Could not read --script-file ${flags.scriptFile}: ${cause.code ?? cause.message}`, { code: "invalid_input" })
    }
  }
  return null
}

async function readMessages(flags) {
  if (flags.messages && flags.messages !== true) {
    let raw
    try {
      raw = JSON.parse(await readFile(flags.messages, "utf8"))
    } catch (cause) {
      throw new StoryTokError(`Could not read --messages ${flags.messages}: ${cause.code ?? cause.message}`, { code: "invalid_input" })
    }
    return Array.isArray(raw) ? raw : raw.messages
  }
  const inline = flags.message === undefined ? [] : [].concat(flags.message)
  return inline.map((line) => {
    const match = /^\s*(left|right|them|you)\s*(?:\[(\w+)\])?\s*:\s*(.+)$/i.exec(String(line))
    if (!match) throw new StoryTokError(`Message must look like "left: text" or "right[short]: text", got: ${line}`, { code: "invalid_input" })
    const side = /^(right|you)$/i.test(match[1]) ? "right" : "left"
    return { side, text: match[3].trim(), pause: match[2] ?? "none" }
  })
}

export async function runCli(argv) {
  const { _: positional, flags } = parseArgs(argv)
  const command = positional[0]
  const json = Boolean(flags.json)

  if (flags.version || command === "version") {
    print(VERSION)
    return 0
  }
  if (!command || flags.help || command === "help") {
    print(HELP)
    return 0
  }

  const clientName = typeof flags.client === "string" ? flags.client : `cli/${VERSION}`

  try {
    if (command === "login") {
      const anon = new StoryTokClient({ client: clientName })
      const started = await anon.startDeviceLogin(clientName)
      print(`Open ${started.verification_uri_complete}`)
      print(`and approve code ${started.user_code} (expires in ${Math.round(started.expires_in / 60)} min). Waiting…`)
      const done = await anon.finishDeviceLogin(started.device_code, {
        intervalS: started.interval ?? 3,
        timeoutS: asNumber(flags.timeout, Math.min(600, started.expires_in ?? 600)),
        onTick: () => output.write("."),
      })
      output.write("\n")
      const config = await readConfig()
      await writeConfig({ ...config, apiKey: done.api_key, keyName: done.key_name, connectedAt: new Date().toISOString() })
      print(`Connected as "${done.key_name}". Key saved to your config; STORYTOK_API_KEY overrides it if set.`)
      return 0
    }
    if (command === "logout") {
      const config = await readConfig()
      delete config.apiKey
      delete config.keyName
      await writeConfig(config)
      print("Forgot the stored key. Revoke it at any time in Settings → Developer.")
      return 0
    }

    const client = new StoryTokClient({ apiKey: await resolveApiKey(), client: clientName })

    switch (command) {
      case "account": {
        const data = await client.account()
        print(json ? data : data)
        return 0
      }
      case "catalog": {
        const data = await client.catalog()
        const only = ["voices", "backgrounds", "presets", "themes", "types", "music"].find((k) => flags[k])
        if (!only) {
          print(json ? data : {
            voices: data.voices.map((v) => `${v.id}${v.premium ? " (premium)" : ""} · ${v.language}`),
            caption_presets: data.caption_presets.map((p) => p.id),
            chat_themes: data.chat_themes.map((t) => t.id),
            highlight_types: data.highlight_types,
            backgrounds: data.backgrounds,
            music: data.music,
          })
        } else {
          const key = { presets: "caption_presets", themes: "chat_themes", types: "highlight_types" }[only] ?? only
          print(data[key])
        }
        return 0
      }
      case "reddit": {
        const url = positional[1]
        if (!url) throw new StoryTokError("Usage: storytok reddit <url>", { code: "invalid_input" })
        const data = await client.importReddit(url)
        print(json ? data : `# ${data.post.title}\n\n${data.post.content}\n\n(${data.post.metadata.subreddit} · ${data.post.metadata.score} upvotes · ${data.post.metadata.num_comments} comments)`)
        return 0
      }
      case "story": {
        let title = flags.title
        let script = await readScript(flags)
        let introUsername
        let introUpvotes
        let introComments
        if (flags.reddit) {
          const { post } = await client.importReddit(String(flags.reddit))
          title = title && title !== true ? title : post.title
          script = script ?? post.content
          introUsername = post.metadata.author || undefined
          introUpvotes = post.metadata.score || undefined
          introComments = post.metadata.num_comments || undefined
        }
        const payload = buildStoryJob({
          title,
          script,
          voice: flags.voice,
          speed: asNumber(flags.speed, 1.2),
          background: flags.background,
          captions: flags.captions,
          intro: Boolean(flags.intro),
          introUsername: flags.introUsername ?? introUsername,
          introUpvotes: asNumber(flags.introUpvotes, introUpvotes),
          introComments: asNumber(flags.introComments, introComments),
          music: flags.music,
        })
        const result = await createFlow(client, payload, { flags, json })
        print(json ? result : `Job ${result.job.id} is ${result.job.status}. ${siteUrl()}/job/${result.job.id}`)
        return 0
      }
      case "text": {
        const payload = buildTextingJob({
          title: flags.title,
          contact: flags.contact,
          messages: await readMessages(flags),
          theme: flags.theme,
          voices: { left: flags.leftVoice, right: flags.rightVoice },
          narration: flags.narration === false ? "none" : "both",
          speed: asNumber(flags.speed, 1.2),
          sfx: flags.sfx !== false,
          background: flags.background,
          music: flags.music,
        })
        const result = await createFlow(client, payload, { flags, json })
        print(json ? result : `Job ${result.job.id} is ${result.job.status}. ${siteUrl()}/job/${result.job.id}`)
        return 0
      }
      case "captions":
      case "splitscreen":
      case "highlights": {
        const file = positional[1]
        if (!file) throw new StoryTokError(`Usage: storytok ${command} <video> [options]`, { code: "invalid_input" })
        const durationSeconds = await probeDurationSeconds(file)
        if (!json) print(`Uploading ${file}${durationSeconds ? ` (${formatMinutes(durationSeconds / 60)})` : ""}…`)
        const uploadId = await client.uploadFile(file)
        const trim = parseTrim(flags.trim)
        const payload =
          command === "captions"
            ? buildCaptionsJob({ title: flags.title, uploadId, captions: flags.captions, trim, barStyle: flags.bars, music: flags.music })
            : command === "splitscreen"
              ? buildSplitscreenJob({
                  title: flags.title,
                  uploadId,
                  layout: flags.layout,
                  background: flags.background,
                  facecam: flags.facecam ? Object.fromEntries(["x", "y", "w", "h"].map((k, i) => [k, Number(String(flags.facecam).split(",")[i])])) : undefined,
                  captions: flags.captions,
                  trim,
                  barStyle: flags.bars,
                  music: flags.music,
                })
              : buildHighlightsJob({
                  title: flags.title,
                  uploadId,
                  clipCount: asNumber(flags.clips, 3),
                  clipLength: asNumber(flags.length, 30),
                  autoLength: !flags.fixedLength,
                  clipStyle: flags.style,
                  highlightType: flags.type,
                  backgrounds: flags.backgrounds ? String(flags.backgrounds).split(",") : [],
                  captions: flags.captions,
                  trim,
                  barStyle: flags.bars,
                })
        const result = await createFlow(client, payload, { flags, durationSeconds, json })
        print(json ? result : `Job ${result.job.id} is ${result.job.status}. ${siteUrl()}/job/${result.job.id}`)
        return 0
      }
      case "estimate": {
        const format = positional[1]
        let estimateInput
        if (format === "stories" || format === "story") {
          estimateInput = { jobType: "stories", content: await readScript(flags), voice: flags.voice, voice_speed: asNumber(flags.speed, 1.2) }
        } else if (format === "fake_text" || format === "text") {
          const payload = buildTextingJob({ contact: flags.contact ?? "Them", messages: await readMessages(flags), voices: { left: flags.leftVoice, right: flags.rightVoice }, narration: flags.narration === false ? "none" : "both", speed: asNumber(flags.speed, 1.2), background: flags.background ?? "GTA 1.webm" })
          estimateInput = estimateInputFor(payload)
        } else if (["captions", "subtitles", "splitscreen", "highlights"].includes(format)) {
          const file = positional[2]
          const seconds = file ? await probeDurationSeconds(file) : asNumber(flags.seconds, undefined)
          if (!seconds) throw new StoryTokError("Give a video file (with ffprobe installed) or --seconds N.", { code: "invalid_input" })
          estimateInput = { jobType: format === "captions" ? "subtitles" : format, duration_seconds: seconds, ...(parseTrim(flags.trim) ? { trim_start: parseTrim(flags.trim).start, trim_end: parseTrim(flags.trim).end } : {}) }
        } else {
          throw new StoryTokError("Usage: storytok estimate <story|text|captions|splitscreen|highlights> …", { code: "invalid_input" })
        }
        const { estimate } = await client.estimate(estimateInput)
        print(json ? estimate : describeEstimate(estimate))
        return 0
      }
      case "job":
      case "wait": {
        const id = positional[1]
        if (!id) throw new StoryTokError(`Usage: storytok ${command} <job id>`, { code: "invalid_input" })
        const result =
          command === "wait" || flags.wait
            ? await client.waitForJob(id, { timeoutS: asNumber(flags.timeout, 240), onProgress: (job) => { if (!json) output.write(`  ${job.status} ${job.progress ?? 0}% ${job.stage ?? ""}\n`) } })
            : await client.getJob(id)
        print(json ? result : `${result.job.status} · ${result.job.progress ?? 0}% · ${result.job.stage ?? ""}${result.download_url ? `\nDownload: ${result.download_url}` : ""}`)
        return 0
      }
      case "download": {
        const id = positional[1]
        if (!id) throw new StoryTokError("Usage: storytok download <job id> [--out DIR]", { code: "invalid_input" })
        const saved = await client.download(id, flags.out === true || !flags.out ? defaultDownloadDir() : flags.out)
        print(json ? saved : saved.files.map((f) => `Saved ${f}`).join("\n"))
        return 0
      }
      case "jobs": {
        const data = await client.listJobs({ limit: asNumber(flags.limit, 20), status: flags.status, jobType: flags.type })
        print(json ? data : data.jobs.map((j) => `${j.id}  ${j.status.padEnd(10)} ${j.job_type.padEnd(11)} ${j.title}`).join("\n") || "No jobs yet.")
        return 0
      }
      default:
        if (json) print({ error: { code: "unknown_command", message: `Unknown command "${command}". Run storytok --help.` } })
        else process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`)
        return 2
    }
  } catch (error) {
    if (error instanceof StoryTokError) {
      if (json) print({ error: { code: error.code, message: error.message, details: error.details } })
      else process.stderr.write(`Error: ${error.message}\n`)
      return error.code === "not_confirmed" ? 3 : 1
    }
    if (json) {
      print({ error: { code: "unexpected", message: String(error?.message ?? error) } })
      return 1
    }
    throw error
  }
}
