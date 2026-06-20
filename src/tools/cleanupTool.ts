import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { cleanupWorkspace } from '../shared/fs/cleanup.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Cleans the workspace by removing temporary directories, build outputs (dist, build, cache, bin), and unwanted dotfiles/folders (.git, .ide, .vscode, .DS_Store), while preserving critical files (node_modules, .env, configurations).'

const SCHEMA = {
  workspaceRoot: z.string().optional().describe('Target workspace root directory to clean up'),
  dryRun: z
    .boolean()
    .optional()
    .describe('If true, previews what would be cleaned up without deleting anything'),
}

export function registerCleanupTool(server: McpServer): void {
  server.tool('cleanup_workspace', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    const dryRun = args.dryRun ?? false

    try {
      const result = await cleanupWorkspace(root, { dryRun })

      const actionHeader = dryRun
        ? '### [Scout Cleanup] Dry Run (Preview - No files deleted)'
        : '### [Scout Cleanup] Workspace Cleanup Completed Successfully'

      const deletedSection =
        result.deleted.length > 0
          ? `**Paths Removed:**\n${result.deleted.map((p) => `- \`${p}\``).join('\n')}`
          : '**Paths Removed:** None.'

      const preservedSection =
        result.preserved.length > 0
          ? `**Critical Paths Preserved:**\n${result.preserved.map((p) => `- \`${p}\``).join('\n')}`
          : '**Critical Paths Preserved:** None.'

      const text = [
        actionHeader,
        '',
        deletedSection,
        '',
        preservedSection,
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [
          {
            type: 'text',
            text: formatDegraded(`cleanup_workspace failed: ${errorMsg}`),
          },
        ],
      }
    }
  })
}
