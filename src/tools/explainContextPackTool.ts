import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ScoutConfig } from '../shared/types/index.js'
import { runExplainContextPack } from '../pipeline/index.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Returns a token-efficient planning outline of relevant code files with collapsed function/class bodies.'

const SCHEMA = {
  task: z.string().describe('The planning or feature implementation task details'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerExplainContextPackTool(server: McpServer, config: ScoutConfig): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runExplainContextPack(args.task, config, root)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text' as const, text: formatDegraded(`explain_context_pack failed: ${errorMsg}`) }] }
    }
  }

  server.tool('explain_context_pack', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_explain_context_pack', DESCRIPTION, SCHEMA, handler)
}
