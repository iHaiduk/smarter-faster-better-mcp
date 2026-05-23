import * as fs from 'node:fs/promises'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { clearL1 } from '../cache.js'
import { l2Clear } from '../l2cache.js'
import { getMapFilePath } from '../config.js'
import { buildMap } from '../indexing/symbol-map/build-map.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION = 'Force rebuild project symbol map and AST import graph. Use when new files are added.'

const SCHEMA = {
  workspaceRoot: z.string().optional().describe('Target workspace root to rebuild map for'),
}

export function registerRefreshMapTool(server: McpServer): void {
  server.tool('refresh_map', DESCRIPTION, SCHEMA, async (args) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const mapPath = getMapFilePath(root)
      await fs.unlink(mapPath).catch(() => undefined)
      clearL1()
      await l2Clear(root)
      const map = await buildMap(root)
      const fileCount = new Set(map.symbols.map((sym) => sym.file)).size
      return {
        content: [
          {
            type: 'text',
            text: `[Scout] Map rebuilt: ${map.symbolsCount} symbols in ${fileCount} files for ${root}`,
          },
        ],
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [{ type: 'text', text: formatDegraded(`refresh_map failed: ${errorMsg}`) }],
      }
    }
  })
}
