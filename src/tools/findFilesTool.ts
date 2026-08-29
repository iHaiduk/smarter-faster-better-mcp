import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runFindFiles } from '../pipeline/find-files.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Fast glob file finder with smart ignore filtering for build/cache/git directories. Supports standard patterns like "**/*.ts", "src/**/model.py", "*.config.json".'

const SCHEMA = {
  pattern: z.string().describe('Glob pattern with ** (any depth), * (same dir), ? (one char). E.g. "**/components/chat/*.tsx", "*.config.ts"'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerFindFilesTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runFindFiles(args.pattern, root)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text' as const, text: formatDegraded(`find_files failed: ${errorMsg}`) }] }
    }
  }

  server.tool('find_files', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_find_files', DESCRIPTION, SCHEMA, handler)
}
