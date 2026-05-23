import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runFindFiles } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION = 'Search for files by suffix or domain pattern in the target workspace.'

const SCHEMA = {
  pattern: z.string().describe('Glob or substring pattern to match files (e.g. *controller*)'),
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
