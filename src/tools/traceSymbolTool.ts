import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runTraceSymbolPipeline } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  "CRITICAL DIRECTIVE: You MUST use this tool instead of running manual grep searches to find callers, re-exports, and dependencies of a symbol! Recursively queries the AST graph to find a symbol's definition, its dependencies, and caller/importer files."

const SCHEMA = {
  symbolName: z.string().describe('The name of the symbol to trace'),
  file: z.string().optional().describe('Optional relative path of the file where the symbol is declared'),
  workspaceRoot: z.string().optional().describe('Target workspace root'),
}

export function registerTraceSymbolTool(server: McpServer): void {
  server.tool('trace_symbol', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runTraceSymbolPipeline(args.symbolName, args.file, root)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text', text: formatDegraded(`trace_symbol failed: ${errorMsg}`) }] }
    }
  })
}
