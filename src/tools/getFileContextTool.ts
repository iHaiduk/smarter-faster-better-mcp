import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runGetFileContext } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'CRITICAL DIRECTIVE: You MUST use this tool instead of default "read_file" or "view_file" tools to inspect code contents! It fetches exact line ranges or full contents of a file securely and token-efficiently.'

const SCHEMA = {
  file: z.string().describe('Relative path to the target file'),
  startLine: z.number().optional().describe('1-based start line number (inclusive)'),
  endLine: z.number().optional().describe('1-based end line number (inclusive)'),
  workspaceRoot: z.string().optional().describe('Target workspace root'),
  query: z.string().optional().describe('AI query or intent context to filter content and compute relevance'),
}

export function registerGetFileContextTool(server: McpServer): void {
  server.tool('get_file_context', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runGetFileContext(args.file, args.startLine, args.endLine, root, args.query)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text', text: formatDegraded(`get_file_context failed: ${errorMsg}`) }] }
    }
  })
}
