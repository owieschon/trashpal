import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const scenarioIds = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'] as const
export type ScenarioId = typeof scenarioIds[number]

type Overlay = { id: ScenarioId; set: Record<string, unknown>; remove: string[] }
type Expected = {
  scenarioId: ScenarioId
  outcome: 'prepare_recovery' | 'hold_for_confirmation' | 'escalate' | 'manual_dispatch_review' | 'context_blocked' | 'unknown_then_reconciled' | 'execution_blocked'
  requiredSkills: string[]
  forbiddenActions: string[]
}

const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function independentContentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function deepClone<T>(value: T): T {
  return structuredClone(value)
}

function pathParts(path: string): string[] {
  return path.split('.').filter(Boolean)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = pathParts(path)
  const final = parts.pop()
  if (!final) throw new Error(`invalid set path ${path}`)
  let cursor: Record<string, unknown> | unknown[] = target
  for (const part of parts) {
    const key = /^\d+$/.test(part) ? Number(part) : part
    const next = Array.isArray(cursor) ? cursor[key as number] : cursor[key as string]
    if (next === null || typeof next !== 'object') {
      const replacement: Record<string, unknown> = {}
      if (Array.isArray(cursor)) cursor[key as number] = replacement
      else cursor[key as string] = replacement
      cursor = replacement
    } else {
      cursor = next as Record<string, unknown> | unknown[]
    }
  }
  const finalKey = /^\d+$/.test(final) ? Number(final) : final
  if (Array.isArray(cursor)) cursor[finalKey as number] = value
  else cursor[finalKey as string] = value
}

function removePath(target: Record<string, unknown>, path: string): void {
  const parts = pathParts(path)
  const final = parts.pop()
  if (!final) throw new Error(`invalid remove path ${path}`)
  let cursor: Record<string, unknown> | unknown[] = target
  for (const part of parts) {
    const key = /^\d+$/.test(part) ? Number(part) : part
    const next = Array.isArray(cursor) ? cursor[key as number] : cursor[key as string]
    if (next === null || typeof next !== 'object') return
    cursor = next as Record<string, unknown> | unknown[]
  }
  const finalKey = /^\d+$/.test(final) ? Number(final) : final
  if (Array.isArray(cursor)) cursor.splice(finalKey as number, 1)
  else delete cursor[finalKey as string]
}

function attachContentHashes(world: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(world.evidence)) throw new Error('world evidence must be an array')
  const evidence = world.evidence as Array<Record<string, unknown>>
  return {
    ...world,
    evidence: evidence.map((item) => ({ ...item, contentHash: independentContentDigest(item.content) })),
  }
}

export function loadScenario(id: ScenarioId): Record<string, unknown> {
  if (!scenarioIds.includes(id)) throw new Error(`unknown scenario ${id}`)
  const world = deepClone(readJson(`${fixturesRoot}/base/world.json`) as Record<string, unknown>)
  const overlay = readJson(`${fixturesRoot}/scenarios/${id}.json`) as Overlay
  if (overlay.id !== id || !overlay.set || !Array.isArray(overlay.remove)) throw new Error(`invalid overlay ${id}`)
  for (const [path, value] of Object.entries(overlay.set)) setPath(world, path, value)
  for (const path of overlay.remove) removePath(world, path)
  return attachContentHashes(world)
}

export function loadExpected(id: ScenarioId) {
  if (!scenarioIds.includes(id)) throw new Error(`unknown scenario ${id}`)
  const expected = readJson(`${fixturesRoot}/expected/${id}.json`) as Expected
  if (expected.scenarioId !== id || !Array.isArray(expected.requiredSkills) || !Array.isArray(expected.forbiddenActions)) {
    throw new Error(`invalid expected result ${id}`)
  }
  return expected
}
