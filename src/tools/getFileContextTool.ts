import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runGetFileContext } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Exact ranges only; call find_code first. Extracts precise code slices with automatically resolved imports and related type declarations from the project map.'

const SCHEMA = {
  file: z.string().describe('Relative path to the target file'),
  startLine: z.number().optional().describe('1-based start line number (inclusive)'),
  endLine: z.number().optional().describe('1-based end line number (inclusive)'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
  query: z.string().optional().describe('AI query or intent context to filter content and compute relevance'),
  full: z.boolean().optional().describe('Escape hatch: set to true to return the entire file without range or query even if over 150 lines'),
}

export function registerGetFileContextTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const res = await runGetFileContext(args.file, args.startLine, args.endLine, root, args.query, args.full)
      return {
        content: [{ type: 'text' as const, text: res.markdown }],
        structuredContent: res.structuredContent as unknown as Record<string, unknown>,
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [{ type: 'text' as const, text: formatDegraded(`get_file_context failed: ${errorMsg}`) }],
        isError: true,
      }
    }
  }

  server.tool('get_file_context', DESCRIPTION, SCHEMA, handler)
}
