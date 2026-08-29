import * as fs from 'node:fs/promises'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { clearL1 } from '../cache/l1.js'
import { l2Clear } from '../cache/l2.js'
import { getMapFilePath } from '../config/index.js'
import { buildMap } from '../indexing/symbol-map/build-map.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { formatDegraded } from '../bundle/formatter/format.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION = 'Force rebuild project symbol map and AST import graph. Use when new files are added.'

const SCHEMA = {
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerRefreshMapTool(server: McpServer): void {
  const handler = async (args: z.infer<z.ZodObject<typeof SCHEMA>>) => {
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
            type: 'text' as const,
            text: `[Scout] Map rebuilt: ${map.symbolsCount} symbols in ${fileCount} files for ${root}`,
          },
        ],
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [{ type: 'text' as const, text: formatDegraded(`refresh_map failed: ${errorMsg}`) }],
      }
    }
  }

  server.tool('refresh_map', DESCRIPTION, SCHEMA, handler)
  server.tool('scout_refresh_map', DESCRIPTION, SCHEMA, handler)
}
