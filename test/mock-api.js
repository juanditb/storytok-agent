// A tiny in-process StoryTok API for tests: enough surface for the CLI and
// the MCP server to run their full flows without touching the network.

import { createServer } from "node:http"

export async function startMockApi({ apiKey = "stk_live_test" } = {}) {
  const state = { jobs: new Map(), idempotency: new Map(), uploads: new Map(), requests: [], device: new Map() }
  let counter = 0
  const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBuffer = Buffer.concat(chunks)
    const isJson = (req.headers["content-type"] ?? "").includes("json")
    const raw = rawBuffer.toString("utf8")
    const body = isJson && raw ? JSON.parse(raw) : null
    const url = new URL(req.url, "http://localhost")
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body })

    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    }
    const fail = (status, code, message) => send(status, { success: false, error: { code, message } })

    const publicPath = url.pathname.startsWith("/api/v1/device/") || url.pathname.startsWith("/put/") || url.pathname.startsWith("/file/")
    if (!publicPath && req.headers.authorization !== `Bearer ${apiKey}`) {
      return fail(401, "unauthorized", "Missing or invalid API key")
    }

    if (url.pathname === "/api/v1/account") {
      return send(200, { success: true, account: { credits: 7, trial_credits: 0 } })
    }
    if (url.pathname === "/api/v1/catalog") {
      return send(200, {
        success: true,
        voices: [
          { id: "Joanna", language: "US English", gender: "female", accent: "US", description: "Professional", premium: false },
          { id: "Bella", language: "US English", gender: "female", accent: "American", description: "Premium", premium: true },
        ],
        caption_presets: [{ id: "classic" }, { id: "hormozi" }],
        chat_themes: [{ id: "imessage_dark" }],
        highlight_types: ["engaging_content"],
        backgrounds: ["GTA 1.webm", "Minecraft 4.mp4"],
        music: [],
      })
    }
    if (url.pathname === "/api/v1/estimate") {
      const credits = body.jobType === "stories" ? Math.max(1, Math.ceil(body.content.split(/\s+/).length / 185)) : body.duration_seconds ? Math.ceil(body.duration_seconds / 60) : 1
      return send(200, { success: true, estimate: { credits_required: credits, estimated_minutes: credits * 0.6, premium_voice: body.voice === "Bella", details: "mock", balance: 7, shortfall: Math.max(0, credits - 7) } })
    }
    if (url.pathname === "/api/v1/reddit/import") {
      return send(200, { success: true, post: { title: "Imported title", content: "Imported body text.", metadata: { subreddit: "r/test", author: "someone", score: 1234, num_comments: 56, awards: [], total_awards_received: 0, original_url: body.url } } })
    }
    if (url.pathname === "/api/v1/uploads" && req.method === "POST") {
      const id = nextId()
      state.uploads.set(id, { status: "declared" })
      return send(200, { success: true, upload: { id, url: `http://localhost:${server.address().port}/put/${id}` } })
    }
    if (url.pathname.startsWith("/put/")) {
      state.uploads.get(url.pathname.slice(5)).bytes = rawBuffer.length
      res.writeHead(200)
      return res.end()
    }
    if (/^\/api\/v1\/uploads\/[^/]+\/complete$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4]
      state.uploads.get(id).status = "verified"
      return send(200, { success: true, upload: { id, status: "verified" } })
    }
    if (url.pathname === "/api/v1/jobs" && req.method === "POST") {
      const key = req.headers["idempotency-key"]
      if (key && state.idempotency.has(key)) {
        return send(200, { success: true, job: state.jobs.get(state.idempotency.get(key)), idempotent_replay: true })
      }
      const id = nextId()
      const job = { id, job_type: body.jobType, title: body.jobData.title, status: "queued", progress: 0, stage: null, credits_reserved: 1, credits_charged: 0, created_at: new Date().toISOString(), client: req.headers["x-storytok-client"] ?? null }
      state.jobs.set(id, job)
      if (key) state.idempotency.set(key, id)
      return send(202, { success: true, job, daily_cap: { cap: 30, remaining: 29 } })
    }
    if (url.pathname === "/api/v1/jobs" && req.method === "GET") {
      return send(200, { success: true, jobs: [...state.jobs.values()] })
    }
    const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/.exec(url.pathname)
    if (jobMatch) {
      const job = state.jobs.get(jobMatch[1])
      if (!job) return fail(404, "not_found", "Job not found")
      // Every poll advances the job so waits terminate quickly in tests.
      if (job.status === "queued") job.status = "processing"
      else if (job.status === "processing") {
        job.status = "completed"
        job.credits_charged = 1
        job.completed_at = new Date().toISOString()
      }
      const payload = { success: true, job }
      if (job.status === "completed") payload.download_url = `http://localhost:${server.address().port}/file/${job.id}.mp4`
      return send(200, payload)
    }
    if (url.pathname.startsWith("/file/")) {
      res.writeHead(200, { "content-type": "video/mp4" })
      return res.end(Buffer.from("not really an mp4"))
    }
    if (url.pathname === "/api/v1/device/code") {
      const deviceCode = `device-${nextId()}`
      state.device.set(deviceCode, { polls: 0, client: body.client })
      return send(200, { success: true, device_code: deviceCode, user_code: "ABCD-2345", verification_uri: "http://localhost/connect", verification_uri_complete: "http://localhost/connect?code=ABCD2345", expires_in: 600, interval: 0.01 })
    }
    if (url.pathname === "/api/v1/device/token") {
      const entry = state.device.get(body.device_code)
      if (!entry) return fail(404, "not_found", "Unknown device code.")
      entry.polls += 1
      if (entry.polls < 3) return fail(428, "authorization_pending", "Waiting for approval.")
      return send(200, { success: true, api_key: apiKey, key_name: `${entry.client} (test)` })
    }
    return fail(404, "not_found", `No mock for ${req.method} ${url.pathname}`)
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
