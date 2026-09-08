import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { StoryTokClient, buildStoryJob, buildTextingJob, captionStyle, estimateInputFor, pauseToMs } from "../src/core.js"
import { runCli } from "../src/cli.js"
import { startMockApi } from "./mock-api.js"

let api

before(async () => {
  api = await startMockApi()
  process.env.STORYTOK_API_URL = api.url
  process.env.STORYTOK_API_KEY = "stk_live_test"
  process.env.XDG_CONFIG_HOME = await mkdtemp(path.join(tmpdir(), "storytok-cfg-"))
})

after(async () => {
  await api.close()
})

describe("builders", () => {
  it("builds a stories payload with caption defaults and a preset", () => {
    const payload = buildStoryJob({ title: "T", script: "hello world", background: "GTA 1.webm", captions: "hormozi" })
    assert.equal(payload.jobType, "stories")
    assert.equal(payload.jobData.subtitle_style.preset, "hormozi")
    assert.equal(payload.jobData.subtitle_style.font_size, 44)
    assert.equal(payload.jobData.enable_intro, false)
  })

  it("passes intro stats only when the intro is on", () => {
    const off = buildStoryJob({ title: "T", script: "x", background: "b", introUsername: "u" })
    assert.equal(off.jobData.intro_username, undefined)
    const on = buildStoryJob({ title: "T", script: "x", background: "b", intro: true, introUsername: "u", introUpvotes: 12 })
    assert.equal(on.jobData.intro_username, "u")
    assert.equal(on.jobData.intro_upvotes, 12)
  })

  it("normalises texting messages and pauses", () => {
    const payload = buildTextingJob({ contact: "Mom", background: "b", messages: [{ side: "you", text: " hi ", pause: "long" }, { side: "left", text: "yo", delay_ms: 250 }] })
    assert.deepEqual(payload.jobData.messages, [
      { side: "right", text: "hi", delay_ms: 3000 },
      { side: "left", text: "yo", delay_ms: 250 },
    ])
    assert.equal(payload.jobData.title, "Mom: hi")
    assert.equal(pauseToMs("short"), 700)
    assert.equal(pauseToMs(99999), 5000)
  })

  it("refuses obviously incomplete inputs", () => {
    assert.throws(() => buildStoryJob({ title: "T", background: "b" }), /script/)
    assert.throws(() => buildTextingJob({ contact: "M", messages: [], background: "b" }), /message/)
  })

  it("maps payloads to estimate inputs", () => {
    const story = buildStoryJob({ title: "T", script: "one two three", voice: "Joanna", background: "b" })
    assert.deepEqual(estimateInputFor(story), { jobType: "stories", content: "one two three", voice: "Joanna", voice_speed: 1.2 })
    assert.equal(estimateInputFor({ jobType: "subtitles", jobData: {} }), null)
    assert.equal(estimateInputFor({ jobType: "subtitles", jobData: {} }, { durationSeconds: 90 }).duration_seconds, 90)
    assert.equal(captionStyle({ position: "top" }).position, "top")
  })
})

describe("client", () => {
  it("sends the client header and an automatic idempotency key", async () => {
    const client = new StoryTokClient({ apiKey: "stk_live_test", client: "test-suite/1" })
    const payload = buildStoryJob({ title: "T", script: "hello", background: "b" })
    const first = await client.createJob(payload)
    const second = await client.createJob(payload)
    assert.equal(second.job.id, first.job.id)
    assert.equal(second.idempotent_replay, true)
    const fresh = await client.createJob(payload, { idempotencyKey: "different" })
    assert.notEqual(fresh.job.id, first.job.id)
    const post = api.state.requests.find((r) => r.path === "/api/v1/jobs" && r.method === "POST")
    assert.equal(post.headers["x-storytok-client"], "test-suite/1")
    assert.match(post.headers["idempotency-key"], /^auto-[0-9a-f]{40}$/)
  })

  it("waits with the long-poll parameter and downloads the result", async () => {
    const client = new StoryTokClient({ apiKey: "stk_live_test" })
    const created = await client.createJob(buildStoryJob({ title: "Wait me", script: "x", background: "b" }), { idempotencyKey: "wait" })
    const done = await client.waitForJob(created.job.id, { timeoutS: 30 })
    assert.equal(done.job.status, "completed")
    const polls = api.state.requests.filter((r) => r.path === `/api/v1/jobs/${created.job.id}`)
    assert.ok(polls.length >= 2)
    const dir = await mkdtemp(path.join(tmpdir(), "storytok-dl-"))
    const saved = await client.download(created.job.id, dir)
    assert.equal(saved.files.length, 1)
    assert.match(saved.files[0], /wait-me-.*\.mp4$/)
    assert.equal(await readFile(saved.files[0], "utf8"), "not really an mp4")
  })

  it("uploads a local file through declare, PUT and complete", async () => {
    const client = new StoryTokClient({ apiKey: "stk_live_test" })
    const dir = await mkdtemp(path.join(tmpdir(), "storytok-up-"))
    const file = path.join(dir, "clip.mp4")
    await writeFile(file, Buffer.alloc(2048, 1))
    const uploadId = await client.uploadFile(file)
    assert.equal(api.state.uploads.get(uploadId).status, "verified")
    assert.equal(api.state.uploads.get(uploadId).bytes, 2048)
  })

  it("explains a missing key instead of sending a request", async () => {
    const client = new StoryTokClient({ apiKey: null })
    await assert.rejects(client.account(), /storytok login/)
  })

  it("completes the device login and stores the key", async () => {
    delete process.env.STORYTOK_API_KEY
    const anon = new StoryTokClient({ client: "test-suite/1" })
    const started = await anon.startDeviceLogin("test-suite/1")
    const done = await anon.finishDeviceLogin(started.device_code, { intervalS: 0.01 })
    assert.equal(done.api_key, "stk_live_test")
    const code = await runCli(["login", "--client", "test-suite/1"])
    assert.equal(code, 0)
    const config = JSON.parse(await readFile(path.join(process.env.XDG_CONFIG_HOME, "storytok", "config.json"), "utf8"))
    assert.equal(config.apiKey, "stk_live_test")
    process.env.STORYTOK_API_KEY = "stk_live_test"
  })
})

describe("cli", () => {
  it("refuses to render without confirmation when not interactive", async () => {
    const code = await runCli(["story", "--title", "T", "--script", "hello there", "--background", "GTA 1.webm", "--json"])
    assert.equal(code, 3)
  })

  it("renders, waits and downloads with --yes --wait --out", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "storytok-cli-"))
    const code = await runCli(["story", "--title", "CLI story", "--script", "hello there", "--background", "GTA 1.webm", "--yes", "--wait", "--out", dir, "--json", "--fresh"])
    assert.equal(code, 0)
    const job = [...api.state.jobs.values()].find((j) => j.title === "CLI story")
    assert.equal(job.status, "completed")
  })

  it("parses inline texting messages", async () => {
    const code = await runCli(["text", "--contact", "Mom", "--message", "left: are you awake", "--message", "right[long]: no", "--background", "GTA 1.webm", "--yes", "--json", "--fresh"])
    assert.equal(code, 0)
    const post = api.state.requests.filter((r) => r.path === "/api/v1/jobs" && r.method === "POST").at(-1)
    assert.deepEqual(post.body.jobData.messages.map((m) => [m.side, m.delay_ms]), [["left", 0], ["right", 3000]])
  })
})
