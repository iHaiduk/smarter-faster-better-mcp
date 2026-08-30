import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runDeadCodePipeline } from '../pipeline/dead-code.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Detects dead / unused code in the project. Identifies unreachable orphan files, dead exports never imported elsewhere, and dead islands using full BFS graph reachability from project entrypoints.'

const SCHEMA = {
  entrypoints: z
    .array(z.string())
    .optional()
    .describe('Explicit entrypoint files or globs (e.g. ["src/index.ts", "src/cli.ts"]). Defaults to auto-discovered package.json and config files.'),
  includeExports: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include unused named exports in the report (default: true).'),
  minConfidence: z
    .number()
    .optional()
    .default(0.7)
    .describe('Minimum confidence threshold (0.0 to 1.0) for reporting dead items (default: 0.7).'),
  workspaceRoot: z
    .string()
    .optional()
    .describe('Target project root directory path (defaults to auto-detected project root).'),
}

export function registerDeadCodeTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runDeadCodePipeline(root, {
        entrypoints: args.entrypoints,
        includeExports: args.includeExports,
        minConfidence: args.minConfidence,
      })
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text' as const, text: formatDegraded(`dead_code failed: ${errorMsg}`) }] }
    }
  }

  server.tool('dead_code', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_dead_code', DESCRIPTION, SCHEMA, handler)
}
