import { readMap } from '../cache/map-cache.js'
import { analyzeSubsystems, type LouvainOptions } from '../analysis/louvain.js'
import { toStructuredJSON } from '../bundle/formatter/format.js'
import type { ExtractedSymbol } from '../shared/types/index.js'

export interface SubsystemPipelineOptions extends LouvainOptions {
  readonly minClusterSize?: number
}

/**
 * Runs Louvain community detection on project map and formats subsystem architecture.
 */
export async function runSubsystemClustersPipeline(
  targetRoot = process.cwd(),
  options: SubsystemPipelineOptions = {},
): Promise<string> {
  const map = await readMap(targetRoot)
  const metrics = analyzeSubsystems(map, options)
  const minClusterSize = options.minClusterSize ?? 1

  const activeClusters = metrics.clusters.filter((c) => c.files.length >= minClusterSize)

  const modularityRating =
    metrics.modularity >= 0.4
      ? 'High (Strong Decoupling)'
      : metrics.modularity >= 0.2
        ? 'Moderate (Good Modular Structure)'
        : 'Low (High Coupling / Monolithic)'

  const sections: string[] = [
    `[Scout: SUBSYSTEM_CLUSTERS]`,
    `## Architectural Subsystem Clusters (Louvain Community Detection)`,
    '',
    `**Modularity Score (Q):** \`${metrics.modularity}\` (${modularityRating})`,
    `**Discovered Subsystems:** ${activeClusters.length}`,
    `**Total Modules / Files:** ${metrics.totalNodes}`,
    `**Total Inter-Module Dependency Edges:** ${metrics.totalEdges}`,
    '',
  ]

  for (const cluster of activeClusters) {
    sections.push(`### 📦 ${cluster.name} (${cluster.files.length} modules)`)
    sections.push(`- **Dominant Directory:** \`${cluster.dominantDir}\``)
    sections.push(`- **Internal Cohesion Ratio:** \`${(cluster.cohesion * 100).toFixed(1)}%\``)
    if (cluster.topKeywords.length > 0) {
      sections.push(`- **Domain Keywords:** ${cluster.topKeywords.map((k) => `\`${k}\``).join(', ')}`)
    }
    sections.push(`- **Files:**`)
    for (const f of cluster.files) {
      sections.push(`  - \`${f}\``)
    }
    sections.push('')
  }

  if (metrics.interClusterDependencies.length > 0) {
    sections.push(`### 🔄 Inter-Subsystem Coupling & Flow`)
    for (const dep of metrics.interClusterDependencies.slice(0, 15)) {
      const fromC = activeClusters.find((c) => c.id === dep.fromCluster)
      const toC = activeClusters.find((c) => c.id === dep.toCluster)
      if (fromC && toC) {
        sections.push(`- **${fromC.name}** → **${toC.name}** *(weight: ${dep.weight})*`)
      }
    }
    sections.push('')
  }

  const results: ExtractedSymbol[] = activeClusters.map((cluster) => ({
    candidate: { file: cluster.dominantDir, symbol: cluster.name, confidence: cluster.cohesion },
    code: `// Subsystem: ${cluster.name}\n// Files:\n${cluster.files.map((f) => `// - ${f}`).join('\n')}`,
    signature: `subsystem: ${cluster.name} (${cluster.files.length} files)`,
    doc: `Cohesion: ${(cluster.cohesion * 100).toFixed(1)}%, Modularity Q: ${metrics.modularity}`,
    imports: [],
    importedBy: [],
    extractionOk: true,
    relevanceTier: 'mustRead' as const,
  }))

  return toStructuredJSON(
    sections.join('\n'),
    results,
    metrics.modularity >= 0.2 ? 1.0 : 0.8,
    `Louvain community clustering complete: ${activeClusters.length} subsystems discovered (Modularity Q=${metrics.modularity}).`,
    metrics.modularity < 0.2
      ? ['Consider refactoring cross-module imports to improve subsystem cohesion.']
      : [],
    [],
    map,
  )
}
