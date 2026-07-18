import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('human and agent program source', () => {
  it('generates a human reference with the same six skills', () => {
    const reference = readFileSync(new URL('../../docs/reference/generated/recovery-program.md', import.meta.url), 'utf8')
    expect(reference.match(/^\| `[^`]+` \|/gm)).toHaveLength(6)
    expect(reference).toContain('prepare_recovery')
    expect(reference).toContain('case_scoped_read_only')
  })
})
