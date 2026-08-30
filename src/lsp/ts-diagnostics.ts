import * as path from 'node:path'
import { Project, DiagnosticCategory } from 'ts-morph'

import { fileExists } from '../shared/utils/node.js'
import { shouldIgnorePath } from '../shared/constants/ignore-rules.js'

export interface DiagnosticItem {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly code: number
  readonly category: 'error' | 'warning' | 'suggestion' | 'message'
  readonly message: string
  readonly snippet?: string
}

export class TypeScriptDiagnosticsService {
  private project: Project | null = null
  private initializedRoot: string | null = null

  constructor(private readonly targetRoot: string = process.cwd()) {}

  private async getProject(): Promise<Project> {
    if (this.project && this.initializedRoot === this.targetRoot) {
      return this.project
    }

    const tsConfigPath = path.join(this.targetRoot, 'tsconfig.json')
    const hasTsConfig = await fileExists(tsConfigPath)

    if (hasTsConfig) {
      this.project = new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: false,
      })
    } else {
      this.project = new Project({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
        },
      })
    }

    this.initializedRoot = this.targetRoot
    return this.project
  }

  public async syncFile(relPath: string): Promise<void> {
    if (!this.project) return
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(this.targetRoot, relPath)
    const sourceFile = this.project.getSourceFile(absPath)
    if (sourceFile) {
      await sourceFile.refreshFromFileSystem()
    } else {
      if (await fileExists(absPath)) {
        this.project.addSourceFileAtPath(absPath)
      }
    }
  }

  public removeFile(relPath: string): void {
    if (!this.project) return
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(this.targetRoot, relPath)
    const sourceFile = this.project.getSourceFile(absPath)
    if (sourceFile) {
      this.project.removeSourceFile(sourceFile)
    }
  }

  public async getDiagnostics(options: {
    file?: string
    severity?: 'error' | 'warning' | 'all'
    limit?: number
  } = {}): Promise<DiagnosticItem[]> {
    const project = await this.getProject()
    const { file, severity = 'all', limit = 50 } = options

    let sourceFiles = project.getSourceFiles()

    if (file) {
      const targetAbs = path.isAbsolute(file) ? file : path.join(this.targetRoot, file)
      sourceFiles = sourceFiles.filter((sf) => sf.getFilePath() === targetAbs)
      if (sourceFiles.length === 0 && (await fileExists(targetAbs))) {
        const added = project.addSourceFileAtPath(targetAbs)
        sourceFiles = [added]
      }
    } else {
      // Filter out node_modules and ignored dirs
      sourceFiles = sourceFiles.filter((sf) => {
        const rel = path.relative(this.targetRoot, sf.getFilePath())
        return !shouldIgnorePath(rel) && !rel.startsWith('node_modules')
      })
    }

    const items: DiagnosticItem[] = []

    for (const sf of sourceFiles) {
      const diagnostics = sf.getPreEmitDiagnostics()
      for (const diag of diagnostics) {
        const cat = diag.getCategory()
        let categoryStr: DiagnosticItem['category'] = 'error'
        if (cat === DiagnosticCategory.Warning) categoryStr = 'warning'
        else if (cat === DiagnosticCategory.Suggestion) categoryStr = 'suggestion'
        else if (cat === DiagnosticCategory.Message) categoryStr = 'message'

        if (severity === 'error' && categoryStr !== 'error') continue
        if (severity === 'warning' && categoryStr !== 'error' && categoryStr !== 'warning') continue

        const start = diag.getStart()
        let line = 1
        let column = 1
        let snippet: string | undefined

        if (start !== undefined) {
          const lcp = sf.getLineAndColumnAtPos(start)
          line = lcp.line
          column = lcp.column

          const fullText = sf.getFullText()
          const lineStart = fullText.lastIndexOf('\n', start) + 1
          let lineEnd = fullText.indexOf('\n', start)
          if (lineEnd === -1) lineEnd = fullText.length
          snippet = fullText.substring(lineStart, lineEnd).trim()
        }

        const filePath = path.relative(this.targetRoot, sf.getFilePath()) || sf.getFilePath()

        const msgText = diag.getMessageText()
        const message = typeof msgText === 'string' ? msgText : msgText.getMessageText()

        items.push({
          file: filePath,
          line,
          column,
          code: diag.getCode(),
          category: categoryStr,
          message,
          snippet,
        })

        if (items.length >= limit) {
          return items
        }
      }
    }

    return items
  }
}
