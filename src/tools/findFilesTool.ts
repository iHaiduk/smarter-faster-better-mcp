import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runFindFiles } from '../pipeline/find-files.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'CRITICAL: You MUST use this tool to search for files instead of generic file-system tools (like search_codebase, glob, grep, or bash find). Supports standard glob patterns with ** (recursive any depth), * (single level), and ? (single char). Examples: "**/components/chat/*.tsx", "src/**/utils.ts", "*.config.ts".'

const SCHEMA = {
  pattern: z.string().describe('Glob pattern with ** (any depth), * (same dir), ? (one char). E.g. "**/components/chat/*.tsx", "*.config.ts"'),
  workspaceRoot: z.string().optional().describe('Target workspace root'),
}

export function registerFindFilesTool(server: McpServer): void {
  server.tool('find_files', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runFindFiles(args.pattern, root)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text', text: formatDegraded(`find_files failed: ${errorMsg}`) }] }
    }
  })
}
