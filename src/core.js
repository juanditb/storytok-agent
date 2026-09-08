// Shared core for the StoryTok CLI and MCP server: HTTP client, uploads,
// estimates, job creation with retry-safe idempotency, waiting, downloads,
// and the device-code login. Plain ESM, Node 18+, no build step.

import { createHash, randomUUID } from "node:crypto"
import { createWriteStream, openAsBlob } from "node:fs"
import { mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export const VERSION = "0.1.0"
export const DEFAULT_BASE_URL = "https://storytok.ai/api/v1"
export const SITE_URL = "https://storytok.ai"
export const FORMATS = ["stories", "fake_text", "subtitles", "splitscreen", "highlights"]

const execFileAsync = promisify(execFile)

/* ------------------------------------------------------------------ *
 * Config: STORYTOK_API_KEY env wins; otherwise ~/.config/storytok/config.json
 * ------------------------------------------------------------------ */

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "storytok", "config.json")
}

export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"))
  } catch {
    return {}
  }
}

export async function writeConfig(config) {
  const file = configPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
}

export async function resolveApiKey() {
  const fromEnv = process.env.STORYTOK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const config = await readConfig()
  return typeof config.apiKey === "string" ? config.apiKey : null
}

export function baseUrl() {
  const raw = process.env.STORYTOK_API_URL?.trim()
  if (!raw) return DEFAULT_BASE_URL
  // Accept either the site origin or the full /api/v1 base.
  const trimmed = raw.replace(/\/+$/, "")
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`
}

export function siteUrl() {
  return baseUrl().replace(/\/api\/v1$/, "")
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

export class StoryTokError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message)
    this.name = "StoryTokError"
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]
 * @param {string} [options.client]  e.g. "claude-code/2.1" — sent as X-StoryTok-Client
 */
export class StoryTokClient {
  constructor({ apiKey, client } = {}) {
    this.apiKey = apiKey ?? null
    this.client = client ?? `cli/${VERSION}`
    this.base = baseUrl()
  }

  async request(method, route, { body, headers, auth = true, timeoutMs = 120_000 } = {}) {
    const url = `${this.base}${route}`
    const requestHeaders = {
      accept: "application/json",
      "x-storytok-client": this.client,
      ...(headers ?? {}),
    }
    if (auth) {
      if (!this.apiKey) {
        throw new StoryTokError(
          "No API key. Run `storytok login`, or set STORYTOK_API_KEY (create one at storytok.ai/settings/developer).",
          { code: "no_api_key" },
        )
      }
      requestHeaders.authorization = `Bearer ${this.apiKey}`
    }
    let payload
    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json"
      payload = JSON.stringify(body)
    }
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      const error = data?.error ?? {}
      throw new StoryTokError(error.message ?? `HTTP ${response.status}`, {
        status: response.status,
        code: error.code ?? "http_error",
        details: error,
      })
    }
    return data
  }

  get(route, options) {
    return this.request("GET", route, options)
  }

  post(route, body, options) {
    return this.request("POST", route, { ...options, body })
  }

  /* ---------------------------- read ---------------------------- */

  async account() {
    return this.get("/account")
  }

  async catalog() {
    return this.get("/catalog")
  }

  async listJobs({ limit = 20, status, jobType } = {}) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (status) params.set("status", status)
    if (jobType) params.set("job_type", jobType)
    return this.get(`/jobs?${params}`)
  }

  async getJob(jobId, { wait = 0 } = {}) {
    const suffix = wait > 0 ? `?wait=${Math.min(60, Math.floor(wait))}` : ""
    return this.get(`/jobs/${jobId}${suffix}`, { timeoutMs: 90_000 })
  }

  /**
   * Blocks until the job is terminal or `timeoutS` passes, using the API's
   * long-poll so there is one open request instead of a tight loop.
   */
  async waitForJob(jobId, { timeoutS = 600, onProgress } = {}) {
    const deadline = Date.now() + timeoutS * 1000
    let last
    while (true) {
      const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000))
      last = await this.getJob(jobId, { wait: Math.min(60, remaining) })
      onProgress?.(last.job)
      if (["completed", "failed", "canceled"].includes(last.job.status)) return last
      if (Date.now() >= deadline) return { ...last, timed_out: true }
    }
  }

  async estimate(input) {
    return this.post("/estimate", input)
  }

  async importReddit(url) {
    return this.post("/reddit/import", { url }, { timeoutMs: 125_000 })
  }

  /* ---------------------------- write --------------------------- */

  /**
   * Creates a job. `idempotencyKey` defaults to a hash of the payload, so an
   * identical retry within 24 h returns the original job instead of a
   * second render. Pass your own key to force a fresh render of the same
   * inputs (e.g. `randomUUID()`).
   */
  async createJob(payload, { idempotencyKey } = {}) {
    const key = idempotencyKey ?? `auto-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 40)}`
    return this.post("/jobs", payload, { headers: { "idempotency-key": key } })
  }

  /** Declare → PUT → complete. Returns the upload id to use as source_upload_id. */
  async uploadFile(filePath, { onProgress } = {}) {
    const info = await stat(filePath)
    if (!info.isFile()) throw new StoryTokError(`Not a file: ${filePath}`, { code: "invalid_file" })
    const contentType = contentTypeFor(filePath)
    const declared = await this.post("/uploads", {
      filename: path.basename(filePath),
      content_type: contentType,
      size_bytes: info.size,
    })
    const upload = declared.upload
    onProgress?.({ stage: "uploading", bytes: info.size })
    // openAsBlob streams from disk without loading the file into memory.
    const put = await fetch(upload.url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: await openAsBlob(filePath, { type: contentType }),
      signal: AbortSignal.timeout(30 * 60_000),
    })
    if (!put.ok) throw new StoryTokError(`Upload failed (${put.status})`, { status: put.status, code: "upload_failed" })
    const completed = await this.post(`/uploads/${upload.id}/complete`)
    onProgress?.({ stage: "verified" })
    return completed.upload?.id ?? upload.id
  }

  /** Saves the finished MP4 (or every highlight clip plus the zip) into destDir. */
  async download(jobId, destDir = process.cwd()) {
    const result = await this.getJob(jobId)
    const job = result.job
    if (job.status !== "completed") {
      throw new StoryTokError(`Job is ${job.status}, nothing to download yet.`, { code: "not_ready" })
    }
    await mkdir(destDir, { recursive: true })
    const files = []
    const slug = slugify(job.title || job.job_type)
    if (Array.isArray(result.clips) && result.clips.length > 0) {
      for (const [index, clip] of result.clips.entries()) {
        if (!clip.download_url) continue
        const file = path.join(destDir, `${slug}-clip-${index + 1}-${slugify(clip.title || "clip")}.mp4`)
        await downloadTo(clip.download_url, file)
        files.push(file)
      }
      if (result.download_url) {
        const file = path.join(destDir, `${slug}-clips.zip`)
        await downloadTo(result.download_url, file)
        files.push(file)
      }
    } else if (result.download_url) {
      const file = path.join(destDir, `${slug}-${jobId.slice(0, 8)}.mp4`)
      await downloadTo(result.download_url, file)
      files.push(file)
    }
    return { job, files }
  }

  /* ---------------------------- login --------------------------- */

  async startDeviceLogin(client) {
    return this.post("/device/code", { client }, { auth: false })
  }

  /** Polls until approved/expired. Returns { api_key, key_name }. */
  async finishDeviceLogin(deviceCode, { intervalS = 3, timeoutS = 600, onTick } = {}) {
    const deadline = Date.now() + timeoutS * 1000
    while (Date.now() < deadline) {
      try {
        const data = await this.post("/device/token", { device_code: deviceCode }, { auth: false })
        return data
      } catch (error) {
        if (error instanceof StoryTokError && error.status === 428) {
          onTick?.()
          await sleep(intervalS * 1000)
          continue
        }
        throw error
      }
    }
    throw new StoryTokError("Timed out waiting for approval. Run `storytok login` again.", { code: "login_timeout" })
  }
}

/* ------------------------------------------------------------------ *
 * Format builders: friendly inputs → API payloads
 * ------------------------------------------------------------------ */

const DEFAULT_CAPTIONS = {
  font_size: 44,
  text_color: "#FFFFFF",
  border_color: "#000000",
  border_width: 6,
  position: "center",
}

/** "hormozi" → full subtitle_style; an object is merged over the defaults. */
export function captionStyle(input) {
  if (!input) return { ...DEFAULT_CAPTIONS, preset: "classic" }
  if (typeof input === "string") return { ...DEFAULT_CAPTIONS, preset: input }
  return { ...DEFAULT_CAPTIONS, ...input }
}

export function buildStoryJob({
  title,
  script,
  voice = "Joanna",
  speed = 1.2,
  background,
  captions,
  intro = false,
  introUsername,
  introUpvotes,
  introComments,
  music,
}) {
  if (!title) throw new StoryTokError("A title is required.", { code: "invalid_input" })
  if (!script) throw new StoryTokError("A script is required.", { code: "invalid_input" })
  if (!background) throw new StoryTokError("Pick a background from the catalog.", { code: "invalid_input" })
  const jobData = {
    title,
    content: script,
    voice,
    voice_speed: speed,
    background,
    subtitle_style: captionStyle(captions),
    enable_intro: Boolean(intro),
  }
  if (intro) {
    if (introUsername) jobData.intro_username = introUsername
    if (Number.isFinite(introUpvotes)) jobData.intro_upvotes = introUpvotes
    if (Number.isFinite(introComments)) jobData.intro_comments = introComments
  }
  if (music) jobData.music = typeof music === "string" ? { key: music, volume: 0.18 } : music
  return { jobType: "stories", preset: "modern", jobData }
}

export function buildTextingJob({
  title,
  contact,
  messages,
  theme = "imessage_dark",
  voices,
  narration = "both",
  speed = 1.2,
  sfx = true,
  background,
  music,
}) {
  if (!contact) throw new StoryTokError("A contact name is required.", { code: "invalid_input" })
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new StoryTokError("At least one message is required.", { code: "invalid_input" })
  }
  if (!background) throw new StoryTokError("Pick a background from the catalog.", { code: "invalid_input" })
  const normalized = messages.map((message) => ({
    side: message.side === "right" || message.side === "you" ? "right" : "left",
    text: String(message.text ?? "").trim(),
    delay_ms: pauseToMs(message.pause ?? message.delay_ms),
  }))
  const jobData = {
    title: title || `${contact}: ${normalized[0].text.slice(0, 40)}`,
    contact_name: contact,
    messages: normalized,
    theme,
    narration,
    voices: narration === "none" ? { left: "Matthew", right: "Joanna" } : { left: voices?.left ?? "Matthew", right: voices?.right ?? "Joanna" },
    voice_speed: speed,
    sfx: Boolean(sfx),
    background,
  }
  if (music) jobData.music = typeof music === "string" ? { key: music, volume: 0.18 } : music
  return { jobType: "fake_text", preset: "modern", jobData }
}

export function buildCaptionsJob({ title, uploadId, captions, trim, barStyle = "blur", music }) {
  const jobData = { title: title || "Captioned video", source_upload_id: uploadId, subtitle_style: captionStyle(captions), bar_style: barStyle }
  applyTrim(jobData, trim)
  if (music) jobData.music = typeof music === "string" ? { key: music, volume: 0.18 } : music
  return { jobType: "subtitles", preset: "modern", jobData }
}

export function buildSplitscreenJob({ title, uploadId, layout = "classic", background, facecam, captions, trim, barStyle = "blur", music }) {
  if (layout === "classic" && !background) throw new StoryTokError("Classic split screen needs a background.", { code: "invalid_input" })
  const jobData = { title: title || "Split screen", source_upload_id: uploadId, layout, subtitle_style: captionStyle(captions), bar_style: barStyle }
  if (layout === "classic") jobData.background = background
  if (layout === "streamer") jobData.facecam = facecam ?? { x: 0.02, y: 0.02, w: 0.3, h: 0.3 }
  applyTrim(jobData, trim)
  if (music) jobData.music = typeof music === "string" ? { key: music, volume: 0.18 } : music
  return { jobType: "splitscreen", preset: "modern", jobData }
}

export function buildHighlightsJob({ title, uploadId, clipCount = 3, clipLength = 30, autoLength = true, clipStyle = "subtitles", highlightType = "engaging_content", backgrounds = [], captions, trim, barStyle = "blur" }) {
  const jobData = {
    title: title || "Highlights",
    source_upload_id: uploadId,
    clip_count: clipCount,
    clip_length: clipLength,
    auto_clip_length: Boolean(autoLength),
    clip_style: clipStyle,
    highlight_type: highlightType,
    backgrounds: clipStyle === "splitscreen" ? backgrounds : [],
    subtitle_style: captionStyle(captions),
    bar_style: barStyle,
  }
  applyTrim(jobData, trim)
  return { jobType: "highlights", preset: "modern", jobData }
}

/** Converts a job payload into the matching /estimate request. */
export function estimateInputFor(payload, { durationSeconds } = {}) {
  const { jobType, jobData } = payload
  if (jobType === "stories") {
    return { jobType, content: jobData.content, voice: jobData.voice, voice_speed: jobData.voice_speed }
  }
  if (jobType === "fake_text") {
    return { jobType, messages: jobData.messages, voices: jobData.voices, narration: jobData.narration, voice_speed: jobData.voice_speed }
  }
  if (!durationSeconds) return null
  return { jobType, duration_seconds: durationSeconds, trim_start: jobData.trim_start, trim_end: jobData.trim_end }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const PAUSES = { none: 0, short: 700, medium: 1500, long: 3000 }

export function pauseToMs(value) {
  if (value === undefined || value === null || value === "") return 0
  if (typeof value === "number") return Math.max(0, Math.min(5000, Math.round(value)))
  if (value in PAUSES) return PAUSES[value]
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.round(n))) : 0
}

function applyTrim(jobData, trim) {
  if (!trim) return
  if (Number.isFinite(trim.start) && trim.start > 0) jobData.trim_start = trim.start
  if (Number.isFinite(trim.end) && trim.end > 0) jobData.trim_end = trim.end
}

export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return (
    {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".avi": "video/x-msvideo",
      ".m4v": "video/x-m4v",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".wav": "audio/wav",
    }[ext] ?? "application/octet-stream"
  )
}

/** Source length via ffprobe when installed; null otherwise (estimate then falls back to 1 credit). */
export async function probeDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath])
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
  } catch {
    return null
  }
}

export function slugify(value, max = 48) {
  const full = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (full.length <= max) return full || "video"
  // Cut at a word boundary so file names never end mid-word.
  const cut = full.slice(0, max + 1)
  const boundary = cut.lastIndexOf("-")
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut.slice(0, max)) || "video"
}

export function formatCredits(n) {
  return `${n} credit${n === 1 ? "" : "s"}`
}

export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes * 60))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} s`
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function newIdempotencyKey() {
  return randomUUID()
}

async function downloadTo(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new StoryTokError(`Download failed (${response.status})`, { status: response.status, code: "download_failed" })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
}
