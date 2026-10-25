import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runBlastRadiusPipeline } from '../pipeline/blast-radius.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Analyzes the blast radius of changing a code symbol. Shows all files, modules, and execution flows that would be affected by modifying the target symbol. Use before refactoring, renaming, or deleting shared code.'

const SCHEMA = {
  symbolName: z.string().describe('Name of the symbol to analyze'),
  file: z.string().describe('File path where the symbol is defined'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerBlastRadiusTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const res = await runBlastRadiusPipeline(args.symbolName, args.file, root)
      return {
        content: [{ type: 'text' as const, text: res.markdown }],
        structuredContent: res.structuredContent as unknown as Record<string, unknown>,
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [{ type: 'text' as const, text: formatDegraded(`blast_radius failed: ${errorMsg}`) }],
        isError: true,
      }
    }
  }

  server.tool('blast_radius', DESCRIPTION, SCHEMA, handler)
}
