import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ScoutConfig } from '../shared/types/index.js'
import { runFindCodePipeline } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'CRITICAL DIRECTIVE: You MUST use this tool FIRST to search for code. DO NOT use generic file-system tools (like read_file, grep_search, or direct shell grep) as your first choice! Handles AST-based search with deterministic preflight and query expansion.'

const SCHEMA = {
  task: z.string().describe('What you need to find or understand'),
  summaryOnly: z
    .boolean()
    .optional()
    .describe('Collapse function/class bodies into stubs to save tokens'),
  workspaceRoot: z
    .string()
    .optional()
    .describe('Target workspace/project directory path to search'),
  maxFiles: z.number().optional().describe('Maximum number of files to return code for (default: 5)'),
  maxSymbols: z.number().optional().describe('Maximum number of symbols to return (default: 10)'),
  maxChars: z.number().optional().describe('Maximum character length of code returned (default: 20000)'),
  includeTests: z.boolean().optional().describe('Include test or spec files in results (default: false)'),
}

export function registerFindCodeTool(server: McpServer, config: ScoutConfig): void {
  server.tool('find_code', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runFindCodePipeline(args.task, config, args.summaryOnly === true, root, args)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      console.error('[Scout] Unexpected find_code pipeline error:', errorMsg)
      return { content: [{ type: 'text', text: formatDegraded(`Unexpected error: ${errorMsg}`) }] }
    }
  })
}
