#!/usr/bin/env node
import { runCli } from "../src/cli.js"
import { runMcp } from "../src/mcp.js"

const argv = process.argv.slice(2)

if (argv[0] === "mcp") {
  // Everything except JSON-RPC must stay off stdout while serving MCP.
  console.log = (...args) => console.error(...args)
  const inline = argv.find((a) => a.startsWith("--client="))
  const clientFlag = argv.indexOf("--client")
  const client = inline ? inline.slice("--client=".length) : clientFlag >= 0 ? argv[clientFlag + 1] : undefined
  runMcp({ client }).catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
} else {
  // Set the exit code and let the event loop drain: process.exit() would
  // truncate a piped stdout mid-write (the 64 KB pipe buffer on macOS).
  runCli(argv).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    },
  )
}
