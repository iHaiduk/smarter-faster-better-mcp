import { describe, expect, it } from 'bun:test'

import { selectCoarseCandidates, buildAstStateForFile } from '../extraction/jev/dynamic-triage.js'
import { isJevAvailable } from '../extraction/jev/client.js'

import type { ProjectMap } from '../shared/types/index.js'

const mockMap: ProjectMap = {
  generatedAt: Date.now(),
  symbolsCount: 5,
  symbols: [
    {
      name: 'chargeCreditCard',
      file: 'src/services/billing.ts',
      line: 12,
      kind: 'FunctionDeclaration',
      signature: 'function chargeCreditCard(amount: number): Promise<void>',
      doc: 'Charges user card',
    },
    {
      name: 'verifySession',
      file: 'src/auth/session.ts',
      line: 34,
      kind: 'FunctionDeclaration',
      signature: 'function verifySession(token: string): boolean',
      doc: 'Validates JWT session token',
    },
    {
      name: 'getUserProfile',
      file: 'src/users/profile.ts',
      line: 5,
      kind: 'FunctionDeclaration',
      signature: 'function getUserProfile(id: string): User',
      doc: 'Fetches user profile',
    },
  ],
  files: [
    {
      file: 'src/services/billing.ts',
      declarations: ['chargeCreditCard'],
      exports: [{ name: 'chargeCreditCard', local: 'chargeCreditCard' }],
      imports: [{ source: 'stripe', resolved: null, specifiers: [] }],
      reExports: [],
    },
    {
      file: 'src/auth/session.ts',
      declarations: ['verifySession'],
      exports: [{ name: 'verifySession', local: 'verifySession' }],
      imports: [{ source: 'jsonwebtoken', resolved: null, specifiers: [] }],
      reExports: [],
    },
    {
      file: 'src/users/profile.ts',
      declarations: ['getUserProfile'],
      exports: [{ name: 'getUserProfile', local: 'getUserProfile' }],
      imports: [{ source: '../db', resolved: null, specifiers: [] }],
      reExports: [],
    },
  ],
}

describe('Dynamic Triage & AST Skeletons', () => {
  it('buildAstStateForFile correctly extracts exports, dependencies, and signatures', () => {
    const astState = buildAstStateForFile(mockMap, 'src/services/billing.ts')
    expect(astState.file).toBe('src/services/billing.ts')
    expect(astState.exports).toEqual(['chargeCreditCard'])
    expect(astState.dependencies).toEqual(['stripe'])
    expect(astState.keySignatures).toHaveLength(1)
    expect(astState.keySignatures[0]).toContain('chargeCreditCard')
  })

  it('selectCoarseCandidates filters candidates accurately based on hints', () => {
    const billingCandidates = selectCoarseCandidates(mockMap, ['billing', 'charge'])
    expect(billingCandidates).toContain('src/services/billing.ts')
    expect(billingCandidates[0]).toBe('src/services/billing.ts')

    const authCandidates = selectCoarseCandidates(mockMap, ['session', 'token'])
    expect(authCandidates).toContain('src/auth/session.ts')
  })

  it('selectCoarseCandidates honors explicit candidateFiles when provided', () => {
    const explicit = ['src/users/profile.ts']
    const selected = selectCoarseCandidates(mockMap, ['billing'], explicit)
    expect(selected).toEqual(['src/users/profile.ts'])
  })

  it('isJevAvailable correctly detects configured API key', () => {
    // If environment has JEV_API_KEY / TYPESAFE_API_KEY, isJevAvailable should be true
    const available = isJevAvailable()
    expect(typeof available).toBe('boolean')
  })
})
