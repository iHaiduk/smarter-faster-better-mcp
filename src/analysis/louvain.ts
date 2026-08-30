import type { ProjectMap, SubsystemCluster, SubsystemMetrics } from '../shared/types/index.js'

export interface GraphNode {
  readonly id: number
  readonly name: string
}

export interface GraphEdge {
  readonly from: number
  readonly to: number
  readonly weight: number
}

export interface AdjacencyGraph {
  readonly nodes: readonly GraphNode[]
  readonly nodeNameToId: ReadonlyMap<string, number>
  readonly nodeIdToName: ReadonlyMap<number, string>
  // node -> map of target node -> weight
  readonly neighbors: readonly Map<number, number>[]
  readonly degrees: readonly number[]
  readonly totalWeight: number
}

export interface LouvainOptions {
  readonly resolution?: number
  readonly maxIterations?: number
  readonly minImprovement?: number
}

/**
 * Builds a symmetric weighted graph of files from the ProjectMap.
 * Weights are derived from direct imports, specifier counts, and re-exports.
 */
export function buildGraphFromMap(map: ProjectMap): AdjacencyGraph {
  const files: string[] = []
  const nodeNameToId = new Map<string, number>()
  const nodeIdToName = new Map<number, string>()

  if (map.files) {
    for (const f of map.files) {
      if (!nodeNameToId.has(f.file)) {
        const id = files.length
        files.push(f.file)
        nodeNameToId.set(f.file, id)
        nodeIdToName.set(id, f.file)
      }
    }
  }

  // Also include files present in symbols
  for (const s of map.symbols) {
    if (!nodeNameToId.has(s.file)) {
      const id = files.length
      files.push(s.file)
      nodeNameToId.set(s.file, id)
      nodeIdToName.set(id, s.file)
    }
  }

  const n = files.length
  const neighbors: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>())
  const degrees: number[] = new Array(n).fill(0)
  let totalWeight = 0

  function addUndirectedEdge(u: number, v: number, w: number): void {
    if (u === v || w <= 0) return
    const currentUV = neighbors[u]?.get(v) ?? 0
    neighbors[u]?.set(v, currentUV + w)
    if (degrees[u] !== undefined) degrees[u] += w

    const currentVU = neighbors[v]?.get(u) ?? 0
    neighbors[v]?.set(u, currentVU + w)
    if (degrees[v] !== undefined) degrees[v] += w

    // Each undirected edge of weight w contributes 2*w to sum of degrees, and w to total graph weight
    totalWeight += w
  }

  if (map.files) {
    for (const f of map.files) {
      const u = nodeNameToId.get(f.file)
      if (u === undefined) continue

      for (const imp of f.imports) {
        if (!imp.resolved) continue
        const v = nodeNameToId.get(imp.resolved)
        if (v === undefined || v === u) continue
        const specCount = Math.max(1, imp.specifiers.length)
        addUndirectedEdge(u, v, specCount)
      }

      for (const reExp of f.reExports) {
        if (!reExp.resolved) continue
        const v = nodeNameToId.get(reExp.resolved)
        if (v === undefined || v === u) continue
        const specCount = Math.max(1, reExp.specifiers.length)
        addUndirectedEdge(u, v, specCount + 1)
      }
    }
  }

  const nodes: GraphNode[] = files.map((name, id) => ({ id, name }))

  return {
    nodes,
    nodeNameToId,
    nodeIdToName,
    neighbors,
    degrees,
    totalWeight,
  }
}

/**
 * Executes the Louvain community detection algorithm on an AdjacencyGraph.
 * Returns community assignment for each node (nodeId -> communityId).
 */
export function runLouvainClustering(
  graph: AdjacencyGraph,
  options: LouvainOptions = {},
): number[] {
  const resolution = options.resolution ?? 1.0
  const maxIterations = options.maxIterations ?? 20

  const n = graph.nodes.length
  if (n === 0) return []
  if (graph.totalWeight === 0) {
    // Disconnected graph with no edges: each node in its own community
    return Array.from({ length: n }, (_, i) => i)
  }

  const m2 = 2 * graph.totalWeight

  // Fast & robust Louvain optimization loop
  const numNodes = graph.nodes.length
  const communities: number[] = Array.from({ length: numNodes }, (_, i) => i)
  const communityTot: number[] = [...graph.degrees]

  let iter = 0
  let hasMoved = true

  while (hasMoved && iter < maxIterations) {
    iter++
    hasMoved = false

    for (let i = 0; i < numNodes; i++) {
      const cOriginal = communities[i]
      const ki = graph.degrees[i]
      if (cOriginal === undefined || ki === undefined || ki === 0) continue

      // Weights from node i to each neighboring community
      const weightsToCommunity = new Map<number, number>()
      const iNeighbors = graph.neighbors[i]
      if (iNeighbors) {
        for (const [neighbor, w] of iNeighbors.entries()) {
          const cNeighbor = communities[neighbor]
          if (cNeighbor !== undefined) {
            weightsToCommunity.set(cNeighbor, (weightsToCommunity.get(cNeighbor) ?? 0) + w)
          }
        }
      }

      // Remove node i from cOriginal
      if (communityTot[cOriginal] !== undefined) {
        communityTot[cOriginal] -= ki
      }

      // Evaluate best community to place node i
      let bestCommunity = cOriginal
      const origWeight = weightsToCommunity.get(cOriginal) ?? 0
      const origTot = communityTot[cOriginal] ?? 0
      let bestGain = origWeight - resolution * (origTot * ki) / m2

      for (const [cTarget, k_i_in] of weightsToCommunity.entries()) {
        const totTarget = communityTot[cTarget] ?? 0
        const gain = k_i_in - resolution * (totTarget * ki) / m2
        if (gain > bestGain) {
          bestGain = gain
          bestCommunity = cTarget
        }
      }

      // Re-insert node i into chosen best community
      communities[i] = bestCommunity
      const targetTot = communityTot[bestCommunity]
      if (targetTot !== undefined && ki !== undefined) {
        communityTot[bestCommunity] = targetTot + ki
      }

      if (bestCommunity !== cOriginal) {
        hasMoved = true
      }
    }
  }

  // Remap community IDs to contiguous integers 0..k-1
  const uniqueCommunities = Array.from(new Set(communities)).sort((a, b) => a - b)
  const commMap = new Map<number, number>()
  uniqueCommunities.forEach((c, idx) => commMap.set(c, idx))
  return communities.map((c) => commMap.get(c) ?? 0)
}

/**
 * Calculates modularity Q of a partition on an AdjacencyGraph.
 */
export function calculateModularity(
  graph: AdjacencyGraph,
  nodeToCommunity: readonly number[],
  resolution = 1.0,
): number {
  if (graph.totalWeight === 0 || graph.nodes.length === 0) return 0
  const m2 = 2 * graph.totalWeight
  let q = 0

  for (let u = 0; u < graph.nodes.length; u++) {
    const cU = nodeToCommunity[u]
    const ku = graph.degrees[u]
    const uNeighbors = graph.neighbors[u]
    if (cU === undefined || ku === undefined || !uNeighbors) continue

    for (const [v, w] of uNeighbors.entries()) {
      const cV = nodeToCommunity[v]
      if (cU === cV) {
        const kv = graph.degrees[v] ?? 0
        q += (w - resolution * (ku * kv) / m2)
      }
    }
  }

  return Number((q / m2).toFixed(4))
}

/**
 * Derives a human-readable subsystem name from the list of files in a cluster.
 */
export function deriveClusterName(files: readonly string[], map: ProjectMap): { name: string; dominantDir: string; keywords: string[] } {
  if (files.length === 0) return { name: 'Empty Subsystem', dominantDir: '', keywords: [] }

  // 1. Find dominant directory
  const dirCounts = new Map<string, number>()
  for (const file of files) {
    const parts = file.split('/')
    const dir = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : 'root'
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }

  let dominantDir = 'root'
  let maxCount = 0
  for (const [dir, count] of dirCounts.entries()) {
    if (count > maxCount) {
      maxCount = count
      dominantDir = dir
    }
  }

  // 2. Extract keywords from symbol names in cluster
  const fileSet = new Set(files)
  const wordFreq = new Map<string, number>()
  const stopWords = new Set(['get', 'set', 'run', 'create', 'build', 'type', 'is', 'has', 'handle', 'to', 'from', 'index', 'default'])

  for (const sym of map.symbols) {
    if (fileSet.has(sym.file)) {
      // Split camelCase and PascalCase
      const words = sym.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-zA-Z0-9]+/)
      for (const w of words) {
        if (w.length > 2 && !stopWords.has(w)) {
          wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1)
        }
      }
    }
  }

  const sortedKeywords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)

  const labelPrefix = dominantDir !== 'root' ? dominantDir.replace(/^src\//, '') : 'core'
  const keywordsStr = sortedKeywords.length > 0 ? ` (${sortedKeywords.slice(0, 2).join(', ')})` : ''
  const name = `Subsystem [${labelPrefix}]${keywordsStr}`

  return {
    name,
    dominantDir,
    keywords: sortedKeywords,
  }
}

/**
 * Builds full subsystem metrics and community taxonomy.
 */
export function analyzeSubsystems(
  map: ProjectMap,
  options: LouvainOptions = {},
): SubsystemMetrics {
  const graph = buildGraphFromMap(map)
  const nodeToCommunity = runLouvainClustering(graph, options)
  const modularity = calculateModularity(graph, nodeToCommunity, options.resolution ?? 1.0)

  // Group files by community ID
  const clusterFilesMap = new Map<number, string[]>()
  for (let i = 0; i < graph.nodes.length; i++) {
    const cId = nodeToCommunity[i]
    const fileName = graph.nodeIdToName.get(i)
    if (cId !== undefined && fileName !== undefined) {
      const list = clusterFilesMap.get(cId) ?? []
      list.push(fileName)
      clusterFilesMap.set(cId, list)
    }
  }

  // Inter-cluster dependency aggregation
  const interDepMap = new Map<string, number>()
  for (let u = 0; u < graph.nodes.length; u++) {
    const cU = nodeToCommunity[u]
    const uNeighbors = graph.neighbors[u]
    if (cU === undefined || !uNeighbors) continue

    for (const [v, w] of uNeighbors.entries()) {
      const cV = nodeToCommunity[v]
      if (cV !== undefined && cU !== cV) {
        const key = `${cU}->${cV}`
        interDepMap.set(key, (interDepMap.get(key) ?? 0) + w)
      }
    }
  }

  const clusters: SubsystemCluster[] = []
  let clusterIndex = 1

  // Sort clusters by size descending
  const sortedCommunityIds = Array.from(clusterFilesMap.keys()).sort(
    (a, b) => (clusterFilesMap.get(b)?.length ?? 0) - (clusterFilesMap.get(a)?.length ?? 0),
  )

  for (const cId of sortedCommunityIds) {
    const clusterFiles = clusterFilesMap.get(cId) ?? []
    const { name, dominantDir, keywords } = deriveClusterName(clusterFiles, map)

    // Compute internal and total edge weights for this cluster
    let internalWeight = 0
    let totalDegree = 0

    for (const file of clusterFiles) {
      const u = graph.nodeNameToId.get(file)
      if (u === undefined) continue
      totalDegree += graph.degrees[u] ?? 0
      const uNeighbors = graph.neighbors[u]
      if (uNeighbors) {
        for (const [v, w] of uNeighbors.entries()) {
          if (nodeToCommunity[v] === cId) {
            internalWeight += w
          }
        }
      }
    }

    // Each internal edge is counted twice in degrees
    const cohesion = totalDegree > 0 ? Number((internalWeight / totalDegree).toFixed(3)) : 1.0

    clusters.push({
      id: clusterIndex++,
      name,
      dominantDir,
      files: clusterFiles.sort(),
      internalEdgeWeight: Math.round(internalWeight / 2),
      totalEdgeWeight: totalDegree,
      cohesion,
      topKeywords: keywords,
    })
  }

  const interClusterDependencies = Array.from(interDepMap.entries()).map(([key, weight]) => {
    const [fromStr, toStr] = key.split('->')
    const fromOrig = Number(fromStr)
    const toOrig = Number(toStr)
    const fromCluster = sortedCommunityIds.indexOf(fromOrig) + 1
    const toCluster = sortedCommunityIds.indexOf(toOrig) + 1
    return { fromCluster, toCluster, weight }
  }).filter((dep) => dep.fromCluster > 0 && dep.toCluster > 0)

  return {
    modularity,
    clustersCount: clusters.length,
    totalNodes: graph.nodes.length,
    totalEdges: Math.round(graph.totalWeight / 2),
    clusters,
    interClusterDependencies,
  }
}
