import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ScoutConfig } from '../shared/types/index.js'
import { runFindCodePipeline } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Use FIRST for any where-is / why / how question; returns only relevant symbols with file:Lx-Ly and relations'

const SCHEMA = {
  task: z.string().describe('What you need to find or understand (e.g. symbol name, feature, or task description)'),
  summaryOnly: z
    .boolean()
    .optional()
    .describe('Collapse function/class bodies into stubs to save tokens'),
  workspaceRoot: z
    .string()
    .optional()
    .describe('Target project root directory path (defaults to auto-detected project root)'),
  maxFiles: z.number().optional().describe('Maximum number of files to return code for (default: 5)'),
  maxSymbols: z.number().optional().describe('Maximum number of symbols to return (default: 10)'),
  maxChars: z.number().optional().describe('Maximum character length of code returned (default: 20000)'),
  includeTests: z.boolean().optional().describe('Include test or spec files in results (default: false)'),
}

export function registerFindCodeTool(server: McpServer, config: ScoutConfig): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const res = await runFindCodePipeline(args.task, config, args.summaryOnly === true, root, args)
      return {
        content: [{ type: 'text' as const, text: res.markdown }],
        structuredContent: res.structuredContent as unknown as Record<string, unknown>,
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      console.error('[Scout] Unexpected find_code pipeline error:', errorMsg)
      return {
        content: [{ type: 'text' as const, text: formatDegraded(`Unexpected error: ${errorMsg}`) }],
        isError: true,
      }
    }
  }

  server.tool('find_code', DESCRIPTION, SCHEMA, handler)
}
