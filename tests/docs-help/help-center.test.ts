import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const helpDirectory = fileURLToPath(new URL('../../docs/help/', import.meta.url))
const pageNames = [
  'index.md',
  'resolve-a-missed-collection.md',
  'review-and-approve-a-recovery.md',
  'check-an-uncertain-dispatch.md',
  'read-a-recovery-receipt.md',
  'developer-reference.md',
] as const

const pageContents = Object.fromEntries(
  pageNames.map((pageName) => [pageName, readFileSync(resolve(helpDirectory, pageName), 'utf8')]),
) as Record<(typeof pageNames)[number], string>

const pageJobs: Record<(typeof pageNames)[number], string> = {
  'index.md': '# Start here: resolve a missed collection safely',
  'resolve-a-missed-collection.md': '# Resolve a missed collection',
  'review-and-approve-a-recovery.md': '# Review and approve a recovery',
  'check-an-uncertain-dispatch.md': '# Check an uncertain dispatch',
  'read-a-recovery-receipt.md': '# Read a recovery receipt',
  'developer-reference.md': '# Find technical references for a TrashPal integration',
}

function internalMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target): target is string => typeof target === 'string')
    .filter((target) => !target.startsWith('http') && !target.startsWith('#'))
    .map((target) => target.split('#', 1)[0]!)
}

describe('Help Center', () => {
  it('keeps the six-page information architecture and dispatcher order', () => {
    const markdownFiles = readdirSync(helpDirectory)
      .filter((entry) => entry.endsWith('.md'))
      .sort()

    expect(markdownFiles).toEqual([...pageNames].sort())

    const journey = [
      'resolve-a-missed-collection.md',
      'review-and-approve-a-recovery.md',
      'check-an-uncertain-dispatch.md',
      'read-a-recovery-receipt.md',
    ]
    const positions = journey.map((page) => pageContents['index.md'].indexOf(`](${page})`))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('gives every page one visible job and resolves every internal link', () => {
    for (const pageName of pageNames) {
      const content = pageContents[pageName]
      expect(content.split('\n', 1)[0]).toBe(pageJobs[pageName])

      for (const target of internalMarkdownLinks(content)) {
        expect(existsSync(resolve(dirname(resolve(helpDirectory, pageName)), target))).toBe(true)
      }
    }
  })

  it('teaches the authority and uncertainty boundaries without forbidden overclaims', () => {
    const corpus = Object.values(pageContents).join('\n')

    expect(corpus).toContain('Pal prepares recommendations. A dispatcher approves the exact recovery.')
    expect(pageContents['check-an-uncertain-dispatch.md']).toContain('Do not submit the recovery again.')
    expect(pageContents['read-a-recovery-receipt.md']).toContain('not evidence that the collection was completed')

    const forbiddenClaims = [
      /\bPal automatically dispatches\b/i,
      /\bPal (?:can|will) dispatch\b/i,
      /\bPal approves\b/i,
      /\ba receipt (?:confirms|proves|guarantees) (?:a )?(?:completed )?(?:collection|service)\b/i,
      /\ba dispatch acknowledgement (?:confirms|proves|guarantees) (?:a )?(?:completed )?(?:collection|service)\b/i,
    ]

    for (const claim of forbiddenClaims) expect(corpus).not.toMatch(claim)
  })

  it('keeps implementation vocabulary and canonical references out of the dispatcher path', () => {
    const dispatcherPages = pageNames
      .filter((pageName) => pageName !== 'developer-reference.md')
      .map((pageName) => pageContents[pageName])
      .join('\n')

    expect(dispatcherPages).not.toMatch(/\/v\d+\//i)
    expect(dispatcherPages).not.toMatch(/\b(ContextBundle|EvidencePacket|VROOM|hash)\b/i)

    const developerReference = pageContents['developer-reference.md']
    expect(developerReference).toContain('../architecture/CORE_BUILD_CONTRACT.md')
    expect(developerReference).toContain('../reference/generated/recovery-program.md')
    expect(developerReference).toContain('../architecture/DOMAIN_ASSUMPTIONS.md')
    expect(developerReference).toContain('../architecture/SYNTHETIC_SEED_CORPUS.md')
    expect(developerReference).not.toContain('../AGENT_PROFILE.md')
  })
})
