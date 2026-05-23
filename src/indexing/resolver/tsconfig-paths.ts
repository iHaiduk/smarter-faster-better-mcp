import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { cleanJsonText } from '../parser/json-parser.js'
import { fileExists } from '../../utils/nodeUtils.js'

export async function loadTsConfigPaths(
  targetRoot: string,
): Promise<{ baseUrl?: string; paths?: Record<string, string[]> }> {
  try {
    const tsconfigPath = path.join(targetRoot, 'tsconfig.json')
    if (!(await fileExists(tsconfigPath))) return {}
    const text = await fs.readFile(tsconfigPath, 'utf8')
    const cleanText = cleanJsonText(text)
    const json = JSON.parse(cleanText)
    return {
      baseUrl: json.compilerOptions?.baseUrl,
      paths: json.compilerOptions?.paths,
    }
  } catch {
    return {}
  }
}
