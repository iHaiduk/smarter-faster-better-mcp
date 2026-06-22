import * as path from 'node:path'
import { MAX_SYMBOLS_FOR_LLM, STOP_WORDS } from '../../config/index.js'
import { isTestFile } from '../../shared/constants/test-suffixes.js'

import type { ProjectMap, SymbolEntry, LLMCandidate, QueryAnalysis } from '../../shared/types/index.js'

const MIN_KEYWORD_LEN = 3
const FUZZY_MIN_WORD_LEN = 4
const FUZZY_MAX_DISTANCE = 1
const BIGRAM_MIN_DICE = 0.4

/**
 * Regex for extracting likely code identifiers from a natural language query.
 * Matches camelCase, PascalCase, and snake_case identifiers.
 */
const CODE_IDENTIFIER_RE = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*|[a-z]+_[a-z]+_[a-z]+)\b/g

/** Classic two-row Levenshtein. Returns the edit distance between `a` and `b`. */
export function getEditDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i)
  let curr = Array.from({ length: a.length + 1 }, () => 0)

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1
      const deletion = (prev[j] ?? 0) + 1
      const insertion = (curr[j - 1] ?? 0) + 1
      const substitution = (prev[j - 1] ?? 0) + cost
      curr[j] = Math.min(deletion, insertion, substitution)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[a.length] ?? 0
}

function bigrams(value: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2))
  return out
}

function diceCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return (2 * shared) / (a.size + b.size)
}

interface KeywordSpec {
  readonly word: string
  readonly grams: ReadonlySet<string>
  readonly fuzzy: boolean
}

/** Prepares a list of keywords from a query. */
export function prepareKeywords(task: string): KeywordSpec[] {
  const rawWords = task
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((word) => word.length >= MIN_KEYWORD_LEN && !STOP_WORDS.has(word))

  return rawWords.map((word) => ({
    word,
    grams: bigrams(word),
    fuzzy: word.length >= FUZZY_MIN_WORD_LEN,
  }))
}

/** Extracts likely code identifiers (camelCase/PascalCase/snake_case) from a query. */
export function extractCodeIdentifiers(task: string): string[] {
  const matches = task.match(CODE_IDENTIFIER_RE) ?? []
  // Also extract any word that looks like a symbol (contains uppercase after lowercase)
  const additional = task.split(/[\s,;.!?()[\]{}]+/).filter((word) => {
    if (word.length < 3) return false
    // camelCase or PascalCase
    if (/^[a-z][a-zA-Z0-9]*[A-Z]/.test(word)) return true
    if (/^[A-Z][a-z]+[A-Z]/.test(word)) return true
    // snake_case with at least 2 underscores
    if (/^[a-z]+_[a-z]+/.test(word)) return true
    return false
  })
  return [...new Set([...matches, ...additional])]
}

/** Scoring weights for different match types. */
const SCORE_EXACT_NAME = 100
const SCORE_CONTAINS_NAME = 50
const SCORE_EXACT_KEYWORD = 10
const SCORE_FUZZY_KEYWORD = 3
const SCORE_FILE_MATCH = 2

function scoreSymbol(sym: SymbolEntry, keywords: readonly KeywordSpec[], exactIdentifiers: readonly string[]): number {
  const symLower = sym.name.toLowerCase()

  // Highest priority: exact identifier match from query
  for (const ident of exactIdentifiers) {
    const identLower = ident.toLowerCase()
    if (symLower === identLower) return SCORE_EXACT_NAME
    if (symLower.includes(identLower) || identLower.includes(symLower)) return SCORE_CONTAINS_NAME
  }

  const hay = `${sym.name} ${sym.file} ${sym.doc} ${sym.signature}`.toLowerCase()

  let score = 0
  let hayWords: string[] | null = null

  for (const kw of keywords) {
    // Exact keyword match in symbol name gets higher weight
    if (symLower.includes(kw.word)) {
      score += SCORE_EXACT_KEYWORD
      continue
    }
    if (hay.includes(kw.word)) {
      score += SCORE_FUZZY_KEYWORD
      continue
    }
    if (!kw.fuzzy) continue

    hayWords ??= hay.split(/[\s\W_]+/).filter((w) => w.length >= FUZZY_MIN_WORD_LEN)

    const matched = hayWords.some((hayWord) => {
      const grams = bigrams(hayWord)
      if (diceCoefficient(kw.grams, grams) < BIGRAM_MIN_DICE) return false
      return getEditDistance(kw.word, hayWord) <= FUZZY_MAX_DISTANCE
    })
    if (matched) score += SCORE_FUZZY_KEYWORD
  }

  // File name match bonus
  const fileBasename = path.basename(sym.file, path.extname(sym.file)).toLowerCase()
  for (const kw of keywords) {
    if (fileBasename.includes(kw.word)) {
      score += SCORE_FILE_MATCH
      break
    }
  }

  return score
}

/**
 * Returns the subset of `map.symbols` most relevant to `task`, capped at `MAX_SYMBOLS_FOR_LLM`.
 * When `analysis` is provided, also uses expanded terms, file patterns, and symbol names
 * from query analysis to improve recall.
 */
export function filterMap(
  map: ProjectMap,
  task: string,
  analysis?: QueryAnalysis | null,
): SymbolEntry[] {
  const keywords = prepareKeywords(task)
  const exactIdentifiers = extractCodeIdentifiers(task)

  // Build additional keywords from analysis expanded terms
  const expandedKeywords: KeywordSpec[] = analysis
    ? analysis.expandedTerms.flatMap((term) => prepareKeywords(term))
    : []

  const filePatterns = analysis?.filePatterns ?? []
  const symbolNames = analysis?.symbolNames ?? []

  const allKeywords = [...keywords, ...expandedKeywords]
  const allExactIds = [...exactIdentifiers, ...symbolNames]
  if (allKeywords.length === 0 && filePatterns.length === 0 && allExactIds.length === 0) {
    return map.symbols.slice(0, MAX_SYMBOLS_FOR_LLM)
  }

  const scored = map.symbols
    .map((sym) => {
      let score = scoreSymbol(sym, allKeywords, allExactIds)

      // Boost for symbols whose names match analysis-extracted symbol names
      for (const name of symbolNames) {
        const cleanName = name.toLowerCase()
        const cleanSym = sym.name.toLowerCase()
        if (cleanSym === cleanName) {
          score += 50
        } else if (cleanSym.includes(cleanName) || cleanName.includes(cleanSym)) {
          score += 20
        }
      }

      // Boost for symbols in files matching analysis file patterns
      for (const pattern of filePatterns) {
        if (sym.file.toLowerCase().includes(pattern.toLowerCase())) {
          score += 2
        }
      }

      return { sym, score }
    })
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ sym }) => sym)

  const result = scored.length > 0 ? scored : [...map.symbols]
  if (result.length > MAX_SYMBOLS_FOR_LLM) {
    console.error(`[Scout] Truncating filtered map ${result.length} → ${MAX_SYMBOLS_FOR_LLM}`)
  }
  return result.slice(0, MAX_SYMBOLS_FOR_LLM)
}

function cleanCasing(str: string): string {
  return str.toLowerCase().replace(/[\s\W_]+/g, '')
}

/**
 * Computes deterministic matches using casing mappings, exact symbols, and pattern matching.
 * When `analysis` is provided, also matches against analysis-extracted symbol names
 * and file patterns for better recall on natural language queries.
 * Returns LLMCandidates with calculated confidences.
 */
export function getDeterministicMatches(
  map: ProjectMap,
  task: string,
  includeTests = false,
  analysis?: QueryAnalysis | null,
): LLMCandidate[] {
  const keywords = prepareKeywords(task).map((k) => k.word)
  const analysisSymbolNames = analysis?.symbolNames ?? []

  // Extract exact code identifiers from the query (camelCase, PascalCase, snake_case)
  const exactIdentifiers = extractCodeIdentifiers(task)
  const allExactNames = [...new Set([...exactIdentifiers, ...analysisSymbolNames])]

  if (keywords.length === 0 && allExactNames.length === 0) return []

  const cleanTask = cleanCasing(task)
  const candidates: LLMCandidate[] = []

  for (const sym of map.symbols) {
    if (!includeTests && isTestFile(sym.file)) {
      continue
    }

    const cleanSymName = cleanCasing(sym.name)
    let confidence = 0

    // 0. Exact identifier match from query — highest priority
    // This is the primary fix for "can't find exact symbols" problem.
    // When the query contains a camelCase/PascalCase/snake_case identifier,
    // we check it against symbol names first, before any fuzzy matching.
    for (const name of allExactNames) {
      const cleanName = cleanCasing(name)
      if (cleanName.length < 3) continue
      if (cleanSymName === cleanName) {
        confidence = 1.0
        break
      }
      if (cleanSymName.includes(cleanName) || cleanName.includes(cleanSymName)) {
        confidence = 0.95
        break
      }
    }

    // 1. Exact symbol name in task or vice versa
    if (
      confidence === 0 &&
      (cleanTask.includes(cleanSymName) || cleanSymName.includes(cleanTask))
    ) {
      const isExactMatch = sym.name.toLowerCase() === task.trim().toLowerCase()
      const isSingleWordQuery = keywords.length === 1 && keywords[0] === cleanSymName

      if (sym.kind === 'JSONProperty') {
        confidence = isExactMatch ? 0.9 : 0.5
      } else if (isExactMatch) {
        confidence = 1.0
      } else if (isSingleWordQuery) {
        confidence = 1.0
      } else {
        const isOneOfManyKeywords =
          keywords.length > 1 && keywords.some((k) => cleanCasing(k) === cleanSymName)
        confidence = isOneOfManyKeywords ? 0.8 : 0.9
      }
    }

    // 2. Compound keyword combination match
    if (confidence === 0) {
      const rawWords = task
        .toLowerCase()
        .split(/[\s\W_]+/)
        .filter((word) => word.length >= MIN_KEYWORD_LEN && !STOP_WORDS.has(word))

      if (rawWords.length > 1) {
        const allGroupsMatched = rawWords.every((rw) => cleanSymName.includes(cleanCasing(rw)))
        if (allGroupsMatched) {
          confidence = 0.98
        }
      }
    }

    // 3. Match against analysis file patterns (both file and symbol name must match)
    if (confidence === 0 && analysis) {
      const fileBasename = path.basename(sym.file, path.extname(sym.file)).toLowerCase()
      for (const pattern of analysis.filePatterns) {
        const cp = pattern.toLowerCase()
        if (fileBasename.includes(cp) && cleanSymName.includes(cp)) {
          confidence = 0.85
          break
        }
      }
    }

    // 4. File name matches
    if (confidence === 0) {
      const fileBasename = path.basename(sym.file, path.extname(sym.file)).toLowerCase()
      const cleanFileBase = cleanCasing(fileBasename)
      if (keywords.some((k) => cleanFileBase.includes(cleanCasing(k)))) {
        if (keywords.some((k) => cleanSymName.includes(cleanCasing(k)))) {
          confidence = 0.8
        }
      }
    }

    if (confidence > 0) {
      candidates.push({
        file: sym.file,
        symbol: sym.name,
        confidence,
      })
    }
  }

  // Deduplicate and return top candidates sorted by confidence
  const unique = new Map<string, LLMCandidate>()
  for (const c of candidates) {
    const key = `${c.file}::${c.symbol}`
    const existing = unique.get(key)
    if (!existing || existing.confidence < c.confidence) {
      unique.set(key, c)
    }
  }

  return [...unique.values()].toSorted((a, b) => b.confidence - a.confidence)
}
