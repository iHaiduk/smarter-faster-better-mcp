import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runSubsystemClustersPipeline } from '../pipeline/subsystem-clusters.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Performs Louvain community detection on the project dependency graph to discover architectural subsystems, modules, and domain boundaries with cohesion and coupling metrics.'

const SCHEMA = {
  resolution: z
    .number()
    .optional()
    .default(1.0)
    .describe('Resolution parameter γ for Louvain modularity (default: 1.0). Higher values produce smaller, finer-grained clusters; lower values produce larger subsystems.'),
  minClusterSize: z
    .number()
    .optional()
    .default(1)
    .describe('Minimum number of files required for a subsystem to be included in the report (default: 1).'),
  workspaceRoot: z
    .string()
    .optional()
    .describe('Target project root directory path (defaults to auto-detected project root).'),
}

export function registerSubsystemClustersTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const text = await runSubsystemClustersPipeline(root, {
        resolution: args.resolution,
        minClusterSize: args.minClusterSize,
      })
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return { content: [{ type: 'text' as const, text: formatDegraded(`subsystem_clusters failed: ${errorMsg}`) }] }
    }
  }

  server.tool('subsystem_clusters', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_cluster_subsystems', DESCRIPTION, SCHEMA, handler)
}
