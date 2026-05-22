import { parseSync } from 'oxc-parser'

const source = `
import { foo as myFoo, bar } from './module'
import defaultVal from 'external-pkg'
import * as ns from './namespace'
export { x, y as z } from './re-export'
export * from './all-re-export'
export default function main() {}
export const myVar = 1
`

const parsed = parseSync('test.ts', source)
console.log(JSON.stringify(parsed.program.body, null, 2))
