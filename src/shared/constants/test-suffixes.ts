export const TEST_FILE_SUFFIXES = [
  '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx',
  '.test.js', '.spec.js', '.test.jsx', '.spec.jsx',
] as const

export type TestFileSuffix = (typeof TEST_FILE_SUFFIXES)[number]

/** Returns true when the path belongs to a test or spec file. */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_SUFFIXES.some((sfx) => filePath.endsWith(sfx))
}
