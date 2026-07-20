import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextOperatorAction, operatorApi, type CaseOperatorView } from './api.js'
import { canonicalReferenceHref } from './references.js'
import { authorityMessage } from './authority.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base: CaseOperatorView = {
  case: {
    id: 'case_greenleaf-operator',
    title: 'Greenleaf Café',
    serviceType: 'Organics recovery',
    priority: 'High',
    serviceWindowEndsAt: '2026-07-21T16:00:00-05:00',
    timeZone: 'America/Chicago',
  },
  summary: { phase: 'source_records_available', whatHappened: 'A service exception needs review.', whatPalChecked: ['Pal checked the case.'], whatIsUnknown: ['Provider acceptance is not completion.'] },
  activity: [{ id: 'signal', label: 'Signal received', detail: 'The service exception entered the case record.', status: 'current' }],
  evidence: [],
  decisionTrace: {
    facts: ['A case fact.'],
    constraint: 'A bounded constraint.',
    recommendedAction: 'Review the case.',
    rejectedAlternatives: ['Dispatch without approval.'],
  },
  receiptAvailable: false,
  nextAction: { kind: 'prepare', label: 'Prepare recovery', requiresApproval: false },
}

describe('nextOperatorAction', () => {
  it('uses the server-owned first action contract', () => {
    expect(nextOperatorAction(base)).toBe('prepare')
  })

  it('uses reconcile only when the server asks for reconciliation', () => {
    expect(nextOperatorAction({
      ...base,
      proposal: {
        id: 'proposal_1',
        digest: 'a'.repeat(64),
        validUntil: '2026-07-21T16:00:00-05:00',
        workOrder: { vehicleId: 'veh_v42', serviceStart: '2026-07-21T14:24:00-05:00', serviceEnd: '2026-07-21T14:39:00-05:00' },
        claims: [],
      },
      operation: { id: 'operation_1', state: 'unknown', revision: 1, updatedAt: '2026-07-21T14:39:00-05:00' },
      nextAction: { kind: 'reconcile', label: 'Reconcile', requiresApproval: false },
    })).toBe('reconcile')
  })

  it('keeps recovery-only reservation distinct from approval', () => {
    expect(nextOperatorAction({
      ...base,
      proposal: {
        id: 'proposal_1',
        digest: 'a'.repeat(64),
        validUntil: '2026-07-21T16:00:00-05:00',
        workOrder: { vehicleId: 'veh_v42', serviceStart: '2026-07-21T14:24:00-05:00', serviceEnd: '2026-07-21T14:39:00-05:00' },
        claims: [],
      },
      approval: { digest: 'b'.repeat(64), proposalDigest: 'a'.repeat(64), validUntil: '2026-07-21T16:00:00-05:00' },
      nextAction: { kind: 'reserve', label: 'Create dispatch request', requiresApproval: false },
    })).toBe('reserve')
  })

  it('preserves reconciliation for a historical decision with a durable operation', () => {
    expect(nextOperatorAction({
      ...base,
      summary: { ...base.summary, phase: 'historical_decision' },
      operation: { id: 'operation_1', state: 'unknown', revision: 2, updatedAt: '2026-07-21T14:39:00-05:00' },
      nextAction: { kind: 'reconcile', label: 'Reconcile the provider outcome', requiresApproval: false },
    })).toBe('reconcile')
  })
})

describe('authority messaging', () => {
  it('does not imply a reconciled operation before Pal has prepared work', () => {
    expect(authorityMessage('prepare', false)).toBe('Pal can inspect the allowed case evidence. No recovery has been prepared or approved.')
  })

  it('keeps a no-action state truthful when no operation exists', () => {
    expect(authorityMessage(null, false)).toBe('Pal can inspect the allowed case evidence. No recovery has been prepared or approved.')
  })

  it('does not erase an existing operation in a no-action state', () => {
    expect(authorityMessage(null, true)).toBe('No additional action is available from this view. The existing operation remains the source of truth.')
  })
})

describe('contextualHelp', () => {
  it('accepts the canonical Markdown article response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      article: {
        topic: 'overview',
        title: 'Start here: resolve a missed collection safely',
        markdown: '# Start here: resolve a missed collection safely\n\nUse the case record.',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(operatorApi.contextualHelp('overview')).resolves.toEqual({
      topic: 'overview',
      title: 'Start here: resolve a missed collection safely',
      markdown: '# Start here: resolve a missed collection safely\n\nUse the case record.',
    })
    expect(fetchMock).toHaveBeenCalledWith('/v1/operator/help?topic=overview', expect.objectContaining({
      credentials: 'include',
      headers: { accept: 'application/json' },
    }))
  })

  it('rejects the retired summary response instead of owning a second Help corpus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      help: { topic: 'overview', title: 'Old summary', summary: 'Do not render this.' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(operatorApi.contextualHelp('overview')).rejects.toMatchObject({ status: 502 })
  })
})

describe('canonical developer reference links', () => {
  it('maps only the four allowlisted technical sources to facade endpoints', () => {
    expect(canonicalReferenceHref('../architecture/CORE_BUILD_CONTRACT.md')).toBe('/v1/operator/help/references/core-build-contract')
    expect(canonicalReferenceHref('../reference/generated/recovery-program.md')).toBe('/v1/operator/help/references/recovery-program')
    expect(canonicalReferenceHref('../architecture/DOMAIN_ASSUMPTIONS.md')).toBe('/v1/operator/help/references/domain-assumptions')
    expect(canonicalReferenceHref('../architecture/SYNTHETIC_SEED_CORPUS.md')).toBe('/v1/operator/help/references/synthetic-seed-corpus')
  })

  it('does not turn arbitrary repository paths into browser links', () => {
    expect(canonicalReferenceHref('../architecture/UNREVIEWED_NOTES.md')).toBeNull()
    expect(canonicalReferenceHref('../../.env')).toBeNull()
    expect(canonicalReferenceHref('https://example.test/reference.md')).toBeNull()
  })
})
