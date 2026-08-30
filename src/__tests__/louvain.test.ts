import { describe, it, expect } from 'bun:test'
import {
  buildGraphFromMap,
  runLouvainClustering,
  calculateModularity,
  analyzeSubsystems,
} from '../analysis/louvain.js'
import type { ProjectMap } from '../shared/types/index.js'

describe('Louvain Community Detection & Subsystem Analysis', () => {
  it('handles empty or zero-weight graphs gracefully', () => {
    const emptyMap: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 0,
      symbols: [],
      files: [],
    }

    const graph = buildGraphFromMap(emptyMap)
    expect(graph.nodes.length).toBe(0)
    expect(graph.totalWeight).toBe(0)

    const clustering = runLouvainClustering(graph)
    expect(clustering).toEqual([])

    const modularity = calculateModularity(graph, clustering)
    expect(modularity).toBe(0)

    const analysis = analyzeSubsystems(emptyMap)
    expect(analysis.clustersCount).toBe(0)
    expect(analysis.modularity).toBe(0)
  })

  it('correctly partitions two distinct 3-cliques connected by a single bridge edge', () => {
    // Clique 1: files a1, a2, a3
    // Clique 2: files b1, b2, b3
    // Bridge: a3 -> b1
    const map: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 6,
      symbols: [
        { name: 'A1', file: 'src/moduleA/a1.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'A2', file: 'src/moduleA/a2.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'A3', file: 'src/moduleA/a3.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'B1', file: 'src/moduleB/b1.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'B2', file: 'src/moduleB/b2.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'B3', file: 'src/moduleB/b3.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
      ],
      files: [
        {
          file: 'src/moduleA/a1.ts',
          imports: [{ source: './a2', resolved: 'src/moduleA/a2.ts', specifiers: [{ local: 'A2', imported: 'A2' }] }],
          exports: [],
          reExports: [],
          declarations: ['A1'],
        },
        {
          file: 'src/moduleA/a2.ts',
          imports: [{ source: './a3', resolved: 'src/moduleA/a3.ts', specifiers: [{ local: 'A3', imported: 'A3' }] }],
          exports: [],
          reExports: [],
          declarations: ['A2'],
        },
        {
          file: 'src/moduleA/a3.ts',
          imports: [
            { source: './a1', resolved: 'src/moduleA/a1.ts', specifiers: [{ local: 'A1', imported: 'A1' }] },
            { source: '../moduleB/b1', resolved: 'src/moduleB/b1.ts', specifiers: [{ local: 'B1', imported: 'B1' }] }, // bridge
          ],
          exports: [],
          reExports: [],
          declarations: ['A3'],
        },
        {
          file: 'src/moduleB/b1.ts',
          imports: [{ source: './b2', resolved: 'src/moduleB/b2.ts', specifiers: [{ local: 'B2', imported: 'B2' }] }],
          exports: [],
          reExports: [],
          declarations: ['B1'],
        },
        {
          file: 'src/moduleB/b2.ts',
          imports: [{ source: './b3', resolved: 'src/moduleB/b3.ts', specifiers: [{ local: 'B3', imported: 'B3' }] }],
          exports: [],
          reExports: [],
          declarations: ['B2'],
        },
        {
          file: 'src/moduleB/b3.ts',
          imports: [{ source: './b1', resolved: 'src/moduleB/b1.ts', specifiers: [{ local: 'B1', imported: 'B1' }] }],
          exports: [],
          reExports: [],
          declarations: ['B3'],
        },
      ],
    }

    const analysis = analyzeSubsystems(map)
    expect(analysis.clustersCount).toBe(2)
    expect(analysis.modularity).toBeGreaterThan(0.3)

    // Verify all moduleA files are in the same cluster
    const clusterA = analysis.clusters.find((c) => c.files.includes('src/moduleA/a1.ts'))
    expect(clusterA).toBeDefined()
    expect(clusterA?.files).toContain('src/moduleA/a2.ts')
    expect(clusterA?.files).toContain('src/moduleA/a3.ts')
    expect(clusterA?.files).not.toContain('src/moduleB/b1.ts')

    // Verify all moduleB files are in the other cluster
    const clusterB = analysis.clusters.find((c) => c.files.includes('src/moduleB/b1.ts'))
    expect(clusterB).toBeDefined()
    expect(clusterB?.files).toContain('src/moduleB/b2.ts')
    expect(clusterB?.files).toContain('src/moduleB/b3.ts')
  })
})
