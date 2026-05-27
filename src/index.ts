#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { createRequire } from 'node:module'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadConfig, MissingConfigError } from './config.js'
import { registerAllTools } from './tools/registerTools.js'

const requireUtil = createRequire(import.meta.url)
const PACKAGE_JSON_PATH = '../package.json'
const { version: SCOUT_VERSION } = requireUtil(PACKAGE_JSON_PATH) as { version: string }
const SERVER_NAME = 'mcp-scout'

function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(entry))
  } catch {
    return false
  }
}

async function initializeServer(): Promise<void> {
  const config = loadConfig()
  const mcpServer = new McpServer({ name: SERVER_NAME, version: SCOUT_VERSION })
  
  console.error(`[Scout] Parser mode: ${config.parser}`)
  registerAllTools(mcpServer, config)
  
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
  console.error('[Scout] Server running on stdio')
}

async function main(): Promise<void> {
  try {
    await initializeServer()
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(`[Scout] ${err.message}`)
    } else {
      console.error('[Scout] Fatal startup error:', err)
    }
    process.exit(1)
  }
}

if (isEntrypoint(import.meta.url)) {
  await main()
}
