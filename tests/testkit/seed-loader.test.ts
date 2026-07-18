import { describe, expect, it } from 'vitest'
import { loadExpected, loadScenario, scenarioIds } from '../../packages/testkit/src/index.js'

describe('synthetic seed corpus', () => {
  it('loads every scenario and independent expected result', () => {
    expect(scenarioIds).toHaveLength(11)
    for (const id of scenarioIds) {
      const world = loadScenario(id)
      const expected = loadExpected(id)
      expect(world.fixedClock).toBe('2026-07-21T13:20:00-05:00')
      expect(expected.scenarioId).toBe(id)
    }
  })

  it('attaches stable content hashes to every evidence item', () => {
    const first = loadScenario('C01')
    const second = loadScenario('C01')
    expect(first.evidence).toEqual(second.evidence)
    for (const item of first.evidence as Array<{ contentHash: string }>) {
      expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('keeps messy cases structurally distinct', () => {
    expect(loadScenario('C09')).toHaveProperty('conflictingAccessEvidence.status', 'blocked')
    expect(loadScenario('C10')).toHaveProperty('case.siteId', 'site_greenleaf_c184_alias')
    expect(loadScenario('C11')).toHaveProperty('irrelevantNotes.length', 12)
  })
})
