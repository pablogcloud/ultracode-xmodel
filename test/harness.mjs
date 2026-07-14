// Loads the workflow script with a stubbed Workflow runtime and runs scenarios.
// Usage: node test/harness.mjs
import { readFileSync } from 'node:fs'
import { scenarios } from './scenarios.mjs'

const SRC = new URL('../skills/ultracode-xmodel/ultracode-xmodel.js', import.meta.url)

function makeRuntime(responder, calls) {
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return responder(prompt, opts)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let acc = item
      for (const stage of stages) {
        try { acc = await stage(acc, item, i) } catch { return null }
      }
      return acc
    }))
  return { agent, parallel, pipeline, phase: () => {}, log: () => {},
           budget: { total: null, spent: () => 0, remaining: () => Infinity } }
}

export async function runWorkflow(args, responder) {
  const calls = []
  const rt = makeRuntime(responder, calls)
  const body = readFileSync(SRC, 'utf8').replace(/^export /m, '')
  const fn = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget',
    `return (async () => { ${body} })()`)
  const result = await fn(args, rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, rt.budget)
  return { result, calls }
}

let failed = 0
for (const s of scenarios) {
  try {
    await s.run(runWorkflow)
    console.log(`PASS ${s.name}`)
  } catch (e) {
    failed++
    console.error(`FAIL ${s.name}: ${e.message}`)
  }
}
console.log(`${scenarios.length - failed}/${scenarios.length} scenarios passed`)
process.exit(failed ? 1 : 0)
