// MCP server over stdio. Every creating tool is two-phase: without
// `confirm: true` it returns the estimate; with it, it renders. The tool
// descriptions carry that rule so the model asks the user before spending.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import path from "node:path"
import { z } from "zod"

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
  resolveApiKey,
  defaultDownloadDir,
  siteUrl,
} from "./core.js"

const CONFIRM_RULE =
  "Two-phase: call without `confirm` first to get the cost estimate, show the user the credits and minutes, and only call again with confirm=true after they agree. Rendering spends credits. Repeating a confirm=true call with identical inputs returns the same job instead of charging again (idempotent_replay: true); pass fresh=true only when the user wants a second render."

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }
}

function errorResult(error) {
  const message = error instanceof StoryTokError ? `${error.message}${error.code ? ` (${error.code})` : ""}` : String(error?.message ?? error)
  return { isError: true, content: [{ type: "text", text: message }] }
}

const captionsSchema = z
  .union([
    z.string().describe("A caption preset id from get_catalog, e.g. 'hormozi', 'karaoke', 'classic'."),
    z.object({
      preset: z.string().optional(),
      font_size: z.number().int().min(16).max(72).optional(),
      text_color: z.string().optional(),
      border_color: z.string().optional(),
      border_width: z.number().int().min(0).max(12).optional(),
      position: z.enum(["top", "center", "bottom"]).optional(),
      highlight_color: z.string().optional(),
    }),
  ])
  .optional()

const musicSchema = z
  .union([
    z.string().describe("A music key from get_catalog (stock or the user's own upload)."),
    z.object({ key: z.string(), volume: z.number().int().min(0).max(100).default(18) }).describe("Music key plus volume 0–100 (default 18)."),
  ])
  .optional()
  .describe("Background music. Omit for none.")

/**
 * Map the MCP host's `clientInfo.name` (sent on initialize) to the short
 * client id StoryTok shows in the dashboard, e.g. "claude-code/2.1.0". Unknown
 * hosts keep their own name so they still show up, prefixed to stay distinct.
 */
export function clientIdFromHost(info) {
  const name = String(info?.name ?? "").toLowerCase()
  const version = String(info?.version ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20)
  if (!name) return `mcp/${VERSION}`
  let id
  if (name.includes("claude-code") || name.includes("claude_code")) id = "claude-code"
  else if (name.includes("claude")) id = "claude-desktop"
  else if (name.includes("codex")) id = "codex"
  else if (name.includes("cursor")) id = "cursor"
  else if (name.includes("windsurf")) id = "windsurf"
  else if (name.includes("chatgpt")) id = "chatgpt"
  else id = `mcp-${name.replace(/[^a-z0-9._-]/g, "").slice(0, 30) || "host"}`
  return version ? `${id}/${version}` : id
}

export async function createServer({ client } = {}) {
  const apiKey = await resolveApiKey()
  if (!apiKey) console.error("storytok mcp: no API key found. Set STORYTOK_API_KEY in the MCP config or run `npx -y storytok-agent login`, then restart the MCP server.")
  const api = new StoryTokClient({ apiKey, client: client ?? `mcp/${VERSION}` })
  const server = new McpServer({ name: "storytok", version: VERSION }, { instructions:
    `StoryTok renders vertical (1080×1920) narrated, captioned videos: Reddit stories, texting stories, auto captions, split screen and highlight clips. Credits: 1 per rendered minute (2 with premium voices); failed renders refund automatically. ${CONFIRM_RULE} Use get_catalog for valid voice ids, caption presets, chat themes, backgrounds and highlight types before creating. After creating, wait_for_job then download_job so the user gets the file. Site: ${siteUrl()}` })

  /* --------------------------- read tools --------------------------- */

  server.registerTool(
    "get_account",
    {
      title: "Account and balance",
      description: "Credits available (paid + trial), and this key's remaining daily cap. Quote the balance before spending.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(await api.account())
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "get_catalog",
    {
      title: "Voices, presets, themes, backgrounds",
      description:
        "Everything a job may reference: voice ids (with premium flag and language), caption preset ids, chat theme ids, highlight types, background keys, music keys. Call once and reuse; pass `section` to fetch one list.",
      inputSchema: {
        section: z.enum(["voices", "caption_presets", "chat_themes", "highlight_types", "backgrounds", "music"]).optional(),
        language: z.string().optional().describe("Filter voices by language, e.g. 'US English'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ section, language }) => {
      try {
        const data = await api.catalog()
        if (section === "voices" || (!section && language)) {
          // language only narrows voices; other sections ignore it.
          const voices = data.voices.filter((v) => !language || String(v.language).toLowerCase().includes(language.toLowerCase()))
          return text(voices.map((v) => ({ id: v.id, language: v.language, gender: v.gender, accent: v.accent, description: v.description, premium: v.premium })))
        }
        if (section) return text(data[section])
        return text({
          voices: data.voices.map((v) => `${v.id}${v.premium ? " (premium 2×)" : ""} · ${v.language} · ${v.description}`),
          caption_presets: data.caption_presets.map((p) => `${p.id}: ${p.description ?? p.label ?? ""}`),
          chat_themes: data.chat_themes.map((t) => t.id),
          highlight_types: data.highlight_types,
          backgrounds: data.backgrounds,
          music: data.music,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "import_reddit_post",
    {
      title: "Read a Reddit post",
      description: "Fetches a Reddit post URL into a title, a narratable script and intro-card stats (author, upvotes, comments). Free. Use the result with create_story_video.",
      inputSchema: { url: z.string().url() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        return text((await api.importReddit(url)).post)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  /* -------------------------- create tools -------------------------- */

  async function createOrEstimate(payload, confirm, { durationSeconds, fresh } = {}) {
    const estimateInput = estimateInputFor(payload, { durationSeconds })
    const estimate = estimateInput ? (await api.estimate(estimateInput)).estimate : null
    if (!confirm) {
      return text({
        estimate: estimate ?? { note: "1 credit is reserved now; the charge settles on the source's real length after upload." },
        summary: estimate
          ? `≈ ${formatMinutes(estimate.estimated_minutes)}, ${formatCredits(estimate.credits_required)}${estimate.premium_voice ? " (premium voice, 2× rate)" : ""}. Balance ${estimate.balance}.${estimate.shortfall > 0 ? ` Short by ${estimate.shortfall}: add a pack at ${siteUrl()}/pricing.` : ""}`
          : "Cost is settled on the measured length after upload.",
        next: estimate?.shortfall > 0 ? "Do not confirm; the user needs more credits." : "Ask the user to confirm this cost, then call again with confirm=true.",
      })
    }
    if (estimate?.shortfall > 0) {
      throw new StoryTokError(`Not enough credits: need ${estimate.credits_required}, have ${estimate.balance}. Add a pack at ${siteUrl()}/pricing`, { code: "insufficient_credits" })
    }
    const created = await api.createJob(payload, { idempotencyKey: fresh ? newIdempotencyKey() : undefined })
    return text({
      job: created.job,
      idempotent_replay: Boolean(created.idempotent_replay),
      daily_cap: created.daily_cap,
      page: `${siteUrl()}/job/${created.job.id}`,
      next: "Call wait_for_job, then download_job to save the file for the user.",
    })
  }

  // Story/text tools derive an Idempotency-Key from their inputs, so a retry
  // returns the same job. Upload tools declare a fresh upload each call, so
  // they are not idempotent and a retry after a timeout would render twice.
  const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  const uploadAnnotations = { ...createAnnotations, idempotentHint: false }

  server.registerTool(
    "create_story_video",
    {
      title: "Reddit story video",
      description: `Narrated story over gameplay with word-timed captions and an optional Reddit intro card. Provide the script yourself (write it in the StoryTok house style: first person, hook in the first sentence, 40–120 seconds) or pass reddit_url. ${CONFIRM_RULE}`,
      inputSchema: {
        title: z.string().min(1).max(300).optional().describe("Video title (≤80 characters reads best). Taken from the post when reddit_url is given."),
        script: z.string().min(1).max(12000).optional().describe("The narration. Omit when passing reddit_url."),
        reddit_url: z.string().url().optional().describe("Import title, script and intro stats from this post instead of writing them."),
        voice: z.string().default("Joanna").describe("Voice id from get_catalog. Premium voices cost 2× per minute."),
        speed: z.number().min(0.8).max(1.5).default(1.2),
        background: z.string().describe("Background key from get_catalog, e.g. 'Minecraft 4.mp4', or 'custom:<id>' for the user's own footage."),
        captions: captionsSchema,
        intro: z.boolean().default(false).describe("Open with a Reddit-style title card."),
        intro_username: z.string().max(40).optional(),
        music: musicSchema,
        confirm: z.boolean().default(false),
        fresh: z.boolean().default(false).describe("Force a new render even if identical inputs rendered recently."),
      },
      annotations: createAnnotations,
    },
    async (args) => {
      try {
        let { title, script } = args
        let introUsername = args.intro_username
        let introUpvotes
        let introComments
        if (args.reddit_url) {
          const { post } = await api.importReddit(args.reddit_url)
          title = title || post.title
          script = script || post.content
          introUsername = introUsername || post.metadata.author || undefined
          introUpvotes = post.metadata.score || undefined
          introComments = post.metadata.num_comments || undefined
        }
        const payload = buildStoryJob({ title, script, voice: args.voice, speed: args.speed, background: args.background, captions: args.captions, intro: args.intro, introUsername, introUpvotes, introComments, music: args.music })
        return await createOrEstimate(payload, args.confirm, { fresh: args.fresh })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "create_texting_story",
    {
      title: "Texting story video",
      description: `A phone conversation revealed bubble by bubble over gameplay, one voice per side. Write 10–30 short messages with a twist; put pause 'short' or 'long' before reveals. ${CONFIRM_RULE}`,
      inputSchema: {
        contact: z.string().min(1).max(40).describe("The other person's name shown in the chat header (their messages are on the left)."),
        messages: z
          .array(
            z.object({
              side: z.enum(["left", "right"]).describe("left = the contact, right = 'you'"),
              text: z.string().min(1).max(240),
              pause: z.enum(["none", "short", "medium", "long"]).default("none").describe("Extra typing pause before this message."),
            }),
          )
          .min(1)
          .max(60),
        title: z.string().max(300).optional(),
        theme: z.enum(["imessage_dark", "imessage_light", "whatsapp", "android", "instagram", "snapchat"]).default("imessage_dark"),
        left_voice: z.string().default("Matthew"),
        right_voice: z.string().default("Joanna"),
        narration: z.enum(["both", "none"]).default("both").describe("'none' shows bubbles with reading pauses and no voices (cheaper)."),
        speed: z.number().min(0.8).max(1.5).default(1.2),
        sfx: z.boolean().default(true).describe("Sent/received pop as each bubble lands."),
        background: z.string(),
        music: musicSchema,
        confirm: z.boolean().default(false),
        fresh: z.boolean().default(false),
      },
      annotations: createAnnotations,
    },
    async (args) => {
      try {
        const payload = buildTextingJob({ title: args.title, contact: args.contact, messages: args.messages, theme: args.theme, voices: { left: args.left_voice, right: args.right_voice }, narration: args.narration, speed: args.speed, sfx: args.sfx, background: args.background, music: args.music })
        return await createOrEstimate(payload, args.confirm, { fresh: args.fresh })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  const uploadSchema = {
    file_path: z.string().describe("Absolute path to a local MP4/MOV/WebM the user wants processed."),
    title: z.string().max(140).optional(),
    captions: captionsSchema,
    trim: z.object({ start: z.number().min(0), end: z.number().positive() }).optional().describe("Seconds; omit to use the whole video."),
    confirm: z.boolean().default(false),
    fresh: z.boolean().default(false),
  }

  async function withUpload(args, build, { fresh } = {}) {
    const durationSeconds = await probeDurationSeconds(args.file_path)
    if (!args.confirm) {
      // Estimate from the local file without uploading anything yet.
      const payload = build("pending-upload")
      const estimateInput = estimateInputFor(payload, { durationSeconds })
      const estimate = estimateInput ? (await api.estimate(estimateInput)).estimate : null
      return text({
        estimate: estimate ?? { note: "Install ffprobe to estimate before uploading; otherwise 1 credit is reserved and the charge settles on the real length." },
        summary: estimate ? `${formatMinutes(estimate.estimated_minutes)} of source → ${formatCredits(estimate.credits_required)}. Balance ${estimate.balance}.` : "Cost settles on the measured length.",
        next: estimate?.shortfall > 0 ? "Do not confirm; the user needs more credits." : "Ask the user to confirm, then call again with confirm=true (the file uploads then).",
      })
    }
    const uploadId = await api.uploadFile(args.file_path)
    return createOrEstimate(build(uploadId), true, { durationSeconds, fresh })
  }

  server.registerTool(
    "create_captions_video",
    {
      title: "Auto captions",
      description: `Transcribes a local speaking video and burns styled word-level captions into a vertical export. ${CONFIRM_RULE}`,
      inputSchema: { ...uploadSchema, bar_style: z.enum(["blur", "black"]).default("blur").describe("How landscape sources fill 9:16.") },
      annotations: uploadAnnotations,
    },
    async (args) => {
      try {
        return await withUpload(args, (uploadId) => buildCaptionsJob({ title: args.title, uploadId, captions: args.captions, trim: args.trim, barStyle: args.bar_style }), { fresh: args.fresh })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "create_splitscreen_video",
    {
      title: "Split screen video",
      description: `Classic: the user's video on top, gameplay below. Streamer: cuts the facecam region out of one stream VOD and stacks it over the full frame; ask the user roughly where the facecam sits. ${CONFIRM_RULE}`,
      inputSchema: {
        ...uploadSchema,
        layout: z.enum(["classic", "streamer"]).default("classic"),
        background: z.string().optional().describe("Required for classic: a background key from get_catalog."),
        facecam: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional().describe("Streamer only: facecam rectangle as fractions of the frame."),
        bar_style: z.enum(["blur", "black"]).default("blur"),
      },
      annotations: uploadAnnotations,
    },
    async (args) => {
      try {
        return await withUpload(args, (uploadId) => buildSplitscreenJob({ title: args.title, uploadId, layout: args.layout, background: args.background, facecam: args.facecam, captions: args.captions, trim: args.trim, barStyle: args.bar_style }), { fresh: args.fresh })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "create_highlights",
    {
      title: "Highlight clips",
      description: `Transcribes a long local video, has AI pick the best moments, and exports 1–20 vertical clips ranked by a 0–100 score with a hook line each. ${CONFIRM_RULE}`,
      inputSchema: {
        ...uploadSchema,
        clip_count: z.number().int().min(1).max(20).default(3),
        highlight_type: z.enum(["engaging_content", "funny_moments", "comedy_highlights", "key_insights", "educational_content", "epic_gameplay", "gaming_highlights", "quotable_moments", "engaging_discussions", "business_insights", "professional_advice", "high_energy", "emotional_moments"]).default("engaging_content"),
        clip_style: z.enum(["subtitles", "splitscreen"]).default("subtitles"),
        backgrounds: z.array(z.string()).max(10).default([]).describe("Required for clip_style 'splitscreen' (at least one background key to rotate through); ignored otherwise."),
        auto_length: z.boolean().default(true).describe("Let AI pick each clip's length (15–60 s)."),
        clip_length: z.number().int().min(10).max(90).default(30).describe("Fixed clip length when auto_length is false."),
      },
      annotations: uploadAnnotations,
    },
    async (args) => {
      try {
        return await withUpload(args, (uploadId) => buildHighlightsJob({ title: args.title, uploadId, clipCount: args.clip_count, clipLength: args.clip_length, autoLength: args.auto_length, clipStyle: args.clip_style, highlightType: args.highlight_type, backgrounds: args.backgrounds, captions: args.captions, trim: args.trim }), { fresh: args.fresh })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  /* ---------------------------- job tools --------------------------- */

  server.registerTool(
    "get_job",
    {
      title: "Job status",
      description: "Status, stage, progress, credits charged, and once finished the download URL (and per-clip URLs for highlights).",
      inputSchema: { job_id: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id }) => {
      try {
        return text(await api.getJob(job_id))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "wait_for_job",
    {
      title: "Wait for a render",
      description: "Blocks until the job finishes or timeout_s passes (renders usually take 30–180 s), sending progress notifications while it waits. Returns the finished job or a still-running snapshot with timed_out=true; call again to keep waiting.",
      inputSchema: { job_id: z.string().uuid(), timeout_s: z.number().int().min(5).max(600).default(180) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id, timeout_s }, extra) => {
      try {
        const progressToken = extra?._meta?.progressToken
        const onProgress = async (job) => {
          if (progressToken === undefined || !extra?.sendNotification) return
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: Number(job.progress ?? 0), total: 100, message: `${job.status}${job.stage ? ` · ${job.stage}` : ""}` },
            })
          } catch {
            // A host that dropped the request is not a reason to stop waiting.
          }
        }
        return text(await api.waitForJob(job_id, { timeoutS: timeout_s, onProgress }))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "download_job",
    {
      title: "Download the video",
      description: "Saves the finished MP4 (or every highlight clip plus the zip) into dest_dir on this machine and returns the file paths. Use after wait_for_job reports completed.",
      inputSchema: {
        job_id: z.string().uuid(),
        dest_dir: z.string().optional().describe(`Absolute directory to save into. Pass the user's project or target folder; if omitted the server uses its own working directory (${defaultDownloadDir()}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id, dest_dir }) => {
      try {
        const saved = await api.download(job_id, dest_dir && path.isAbsolute(dest_dir) ? dest_dir : path.resolve(defaultDownloadDir(), dest_dir ?? "."))
        return text({ files: saved.files, job: saved.job })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "list_jobs",
    {
      title: "Recent renders",
      description: "The user's recent jobs, newest first. Filter by status or format.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        status: z.enum(["queued", "starting", "processing", "completed", "failed", "canceled"]).optional(),
        job_type: z.enum(["stories", "fake_text", "subtitles", "splitscreen", "highlights"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, status, job_type }) => {
      try {
        return text((await api.listJobs({ limit, status, jobType: job_type })).jobs)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  /* --------------------------- resources ---------------------------- */

  server.registerResource(
    "catalog",
    "storytok://catalog",
    { title: "StoryTok catalog", description: "Voices, caption presets, chat themes, highlight types, backgrounds and music keys.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await api.catalog(), null, 2) }] }),
  )

  /* ----------------------------- prompts ---------------------------- */

  server.registerPrompt(
    "reddit-story",
    {
      title: "Write and render a Reddit story",
      description: "Turns an idea or a Reddit post into a StoryTok-style script, then renders it.",
      argsSchema: { idea: z.string().describe("A premise, or a Reddit post URL"), voice: z.string().optional(), background: z.string().optional() },
    },
    ({ idea, voice, background }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Make a StoryTok Reddit story video from this: ${idea}

Rules for the script: first person, present tense where it fits, a hook in the first sentence, 90–220 words (about 40–90 seconds), concrete details, one twist, end on the consequence. Do not read a post verbatim; rewrite it as an original telling. Suggest a title of at most 80 characters.

Then: call get_catalog if you need voice or background ids${voice ? ` (use voice ${voice})` : ""}${background ? ` (use background ${background})` : ""}, call create_story_video without confirm to get the cost, show me the script and the cost, and only render after I say yes. When it finishes, download it here.`,
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    "texting-story",
    {
      title: "Write and render a texting story",
      description: "Turns a premise into a 15–30 message conversation with reveals, then renders it.",
      argsSchema: { premise: z.string(), contact: z.string().optional() },
    },
    ({ premise, contact }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Write a texting story for StoryTok: ${premise}${contact ? ` The other person is "${contact}".` : ""}

15–30 messages, each under 120 characters, lowercase texting voice, the reader should always be one message ahead of the reveal. Put pause "long" before the two biggest reveals. Then call create_texting_story without confirm, show me the conversation and the cost, and render only after I agree. Download the result when it finishes.`,
          },
        },
      ],
    }),
  )

  server.api = api
  return server
}

export async function runMcp(options = {}) {
  const server = await createServer(options)
  if (!options.client) {
    // Attribute renders to the host (Claude Code, Cursor…) once it introduces
    // itself, unless --client pinned the name explicitly.
    server.server.oninitialized = () => {
      server.api.client = clientIdFromHost(server.server.getClientVersion())
    }
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
