#!/usr/bin/env node
import { runCli } from "../src/cli.js"
import { runMcp } from "../src/mcp.js"

const argv = process.argv.slice(2)

if (argv[0] === "mcp") {
  // Everything except JSON-RPC must stay off stdout while serving MCP.
  console.log = (...args) => console.error(...args)
  const clientFlag = argv.indexOf("--client")
  runMcp({ client: clientFlag >= 0 ? argv[clientFlag + 1] : undefined }).catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
} else {
  runCli(argv).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exit(1)
    },
  )
}
