/* Build the single classic-script bundle the module loader serves.
 *
 *   src/core.cjs → pure money math (also required directly by tests)
 *   src/ui.js    → ledger, panel and inline pill
 *   src/register.js → loader factory body
 *
 * Run: node scripts/build.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = ['src/core.cjs', 'src/ui.js', 'src/register.js']
// Join with a leading semicolon: each file is an IIFE, and without it the
// next one's `(` would parse as a call of the previous IIFE.
const parts = files.map(file => ';\n' + readFileSync(join(root, file), 'utf8'))

const bundle = `window.__ModuleLoader__.load({
  id: '@local/usage-cost',
  factory(require) {
${parts.join('\n')}
  },
})
`

const target = join(root, 'client.js')
if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8')
  if (current !== bundle) {
    console.error('client.js is out of date: run node scripts/build.mjs')
    process.exit(1)
  }
  console.log('client.js is up to date')
} else {
  writeFileSync(target, bundle)
  console.log('wrote client.js (' + bundle.length + ' bytes)')
}
