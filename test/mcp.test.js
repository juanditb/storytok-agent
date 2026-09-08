import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, describe, it } from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { clientIdFromHost } from "../src/mcp.js"
import { startMockApi } from "./mock-api.js"

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "storytok.js")

let api
let client

before(async () => {
  api = await startMockApi()
  client = new Client({ name: "test", version: "0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp", "--client", "test-suite/1"],
      env: { ...process.env, STORYTOK_API_URL: api.url, STORYTOK_API_KEY: "stk_live_test" },
    }),
  )
})

after(async () => {
  await client.close()
  await api.close()
})

describe("mcp server", () => {
  it("lists the expected tools with annotations", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      "create_captions_video",
      "create_highlights",
      "create_splitscreen_video",
      "create_story_video",
      "create_texting_story",
      "download_job",
      "get_account",
      "get_catalog",
      "get_job",
      "import_reddit_post",
      "list_jobs",
      "wait_for_job",
    ])
    const create = tools.find((t) => t.name === "create_story_video")
    assert.match(create.description, /confirm=true/)
    assert.equal(create.annotations.destructiveHint, false)
    assert.equal(tools.find((t) => t.name === "get_catalog").annotations.readOnlyHint, true)
  })

  it("returns an estimate first and only renders with confirm", async () => {
    const args = { title: "MCP story", script: "hello from the agent", background: "GTA 1.webm", voice: "Joanna" }
    const estimate = await client.callTool({ name: "create_story_video", arguments: args })
    const parsed = JSON.parse(estimate.content[0].text)
    assert.equal(parsed.estimate.credits_required, 1)
    assert.match(parsed.next, /confirm=true/)
    assert.equal([...api.state.jobs.values()].length, 0)

    const created = await client.callTool({ name: "create_story_video", arguments: { ...args, confirm: true } })
    const job = JSON.parse(created.content[0].text)
    assert.equal(job.job.status, "queued")
    assert.equal(job.job.client, "test-suite/1")

    const waited = await client.callTool({ name: "wait_for_job", arguments: { job_id: job.job.id, timeout_s: 30 } })
    assert.equal(JSON.parse(waited.content[0].text).job.status, "completed")
  })

  it("exposes the catalog as a resource and the prompts", async () => {
    const { resources } = await client.listResources()
    assert.equal(resources[0].uri, "storytok://catalog")
    const read = await client.readResource({ uri: "storytok://catalog" })
    assert.ok(JSON.parse(read.contents[0].text).voices.length > 0)
    const { prompts } = await client.listPrompts()
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["reddit-story", "texting-story"])
    const prompt = await client.getPrompt({ name: "reddit-story", arguments: { idea: "my landlord" } })
    assert.match(prompt.messages[0].content.text, /my landlord/)
  })

  it("derives the dashboard client id from the MCP host's clientInfo", () => {
    assert.equal(clientIdFromHost({ name: "claude-code", version: "2.1.0" }), "claude-code/2.1.0")
    assert.equal(clientIdFromHost({ name: "Claude Desktop", version: "1.0" }), "claude-desktop/1.0")
    assert.equal(clientIdFromHost({ name: "cursor-vscode", version: "" }), "cursor")
    assert.equal(clientIdFromHost({ name: "codex-mcp-client" }), "codex")
    assert.equal(clientIdFromHost({ name: "Some Host" }), "mcp-somehost")
    assert.match(clientIdFromHost(undefined), /^mcp\//)
  })

  it("reports API errors as tool errors rather than crashing", async () => {
    const result = await client.callTool({ name: "get_job", arguments: { job_id: "00000000-0000-4000-8000-999999999999" } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /not found/i)
  })
})
