import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ScoutConfig } from '../types.js'

import { registerFindCodeTool } from './findCodeTool.js'
import { registerTraceSymbolTool } from './traceSymbolTool.js'
import { registerGetFileContextTool } from './getFileContextTool.js'
import { registerFindFilesTool } from './findFilesTool.js'
import { registerExplainContextPackTool } from './explainContextPackTool.js'
import { registerRefreshMapTool } from './refreshMapTool.js'

export function registerAllTools(server: McpServer, config: ScoutConfig): void {
  registerFindCodeTool(server, config)
  registerTraceSymbolTool(server)
  registerGetFileContextTool(server)
  registerFindFilesTool(server)
  registerExplainContextPackTool(server, config)
  registerRefreshMapTool(server)
}
