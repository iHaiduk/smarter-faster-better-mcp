import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runTraceSymbolPipeline } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  "Traces callers, re-exports, and dependencies of a symbol across the codebase using the AST graph. Shows where a symbol is defined, imported, and used."

const SCHEMA = {
  symbolName: z.string().describe('The name of the symbol to trace'),
  file: z.string().optional().describe('Optional relative path of the file where the symbol is declared'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerTraceSymbolTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runTraceSymbolPipeline(args.symbolName, args.file, root)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text' as const, text: formatDegraded(`trace_symbol failed: ${errorMsg}`) }] }
    }
  }

  server.tool('trace_symbol', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_trace_symbol', DESCRIPTION, SCHEMA, handler)
}
