import { describe, expect, it, vi } from 'vitest'
import { contentDigest } from '../../packages/contracts/src/index.js'
import {
  runBlackBox,
  type BlackBoxSkillInvoker,
} from '../../packages/agent/src/black-box.mjs'

const observedAt = '2026-07-21T13:20:00-05:00'

function input(maxSkillCalls: number) {
  return {
    schemaVersion: '1.0',
    variant: 'bounded_fixture_pal',
    trigger: {
      tenantId: 'external-tenant',
      caseId: 'external-case',
      programId: 'resolve-commercial-service-exception',
      issueClass: 'service_exception',
    },
    budget: {
      maxSkillCalls,
      maxContextTokens: 8_000,
      maxLatencyMs: 5_000,
      maxEstimatedCostUsd: 0,
    },
    skillTransport: {
      baseUrl: 'http://127.0.0.1:1',
      runToken: 'black-box-regression',
    },
  }
}

function recordedInvoker(calls: string[]): BlackBoxSkillInvoker {
  const responses: Record<string, unknown> = {
    inspect_service_exception: {
      case: {
        evidenceId: 'case-external',
        siteId: 'site-harborworks',
        issue: 'access_exception',
        observedAt,
        freshness: 'fresh',
      },
      candidateEvidence: [
        'agreement-external',
        'access-external',
        'attempt-external',
        'noise-external',
      ],
    },
    get_customer_commitments: {
      evidenceId: 'agreement-external',
      observedAt: '2026-07-21T13:15:00-05:00',
      freshness: 'fresh',
      recoveryDeadline: '2026-07-21T17:30:00-05:00',
      stream: 'organics',
    },
    get_access_evidence: [{
      evidenceId: 'access-external',
      authority: 'customer_report',
      observedAt: '2026-07-21T13:17:00-05:00',
      freshness: 'fresh',
      status: 'confirmed_clear',
      validFrom: '2026-07-21T13:17:00-05:00',
      validUntil: '2026-07-21T16:00:00-05:00',
    }],
    get_field_attempt: {
      evidenceId: 'attempt-external',
      observedAt: '2026-07-21T07:18:00-05:00',
      freshness: 'fresh',
      status: 'unable_to_complete',
      reason: 'Gate was locked during the scheduled service window.',
      validUntil: '2026-07-21T16:30:00-05:00',
    },
    quote_recovery_options: {
      evidenceId: 'quote-external',
      vehicleId: 'veh-v42',
      serviceStart: '2026-07-21T14:30:00-05:00',
      serviceEnd: '2026-07-21T15:00:00-05:00',
      validUntil: '2026-07-21T14:00:00-05:00',
    },
    submit_typed_proposal: { accepted: true },
  }

  return async (_input, skillId, payload = {}) => {
    calls.push(skillId)
    if (skillId === 'submit_typed_proposal') {
      expect(payload.proposal).toMatchObject({
        outcome: 'prepare_recovery',
        vehicleId: 'veh-v42',
        requiresHumanApproval: true,
      })
    }
    return {
      result: responses[skillId],
      receipt: contentDigest({ skillId, ordinal: calls.length }),
      status: 200,
    }
  }
}

describe('black-box production harness enforcement', () => {
  it('rejects non-loopback skill transports before any scoped identifiers are sent', async () => {
    const skillInvoker = vi.fn(recordedInvoker([]))
    await expect(runBlackBox({
      ...input(6),
      skillTransport: { baseUrl: 'https://example.com/skills', runToken: 'ssrf-probe' },
    }, { skillInvoker })).rejects.toThrow('skill transport must use a literal loopback host')
    expect(skillInvoker).not.toHaveBeenCalled()
  })

  it('changes the same external world from prepare to fail-closed when the production call budget changes', async () => {
    const completeCalls: string[] = []
    const complete = await runBlackBox(input(6), { skillInvoker: recordedInvoker(completeCalls) })

    expect(complete.outcome).toBe('prepare_recovery')
    if (!('agentRunTrace' in complete)) throw new Error('production harness trace missing')
    expect(complete.agentRunTrace.stoppedReason).toBe('CITED_PROPOSAL_VALIDATED')
    expect(completeCalls).toEqual([
      'inspect_service_exception',
      'get_customer_commitments',
      'get_access_evidence',
      'get_field_attempt',
      'quote_recovery_options',
      'submit_typed_proposal',
    ])

    const boundedCalls: string[] = []
    const bounded = await runBlackBox(input(5), { skillInvoker: recordedInvoker(boundedCalls) })

    expect(bounded.outcome).toBe('escalate')
    if (!('agentRunTrace' in bounded)) throw new Error('production harness trace missing')
    expect(bounded.agentRunTrace.stoppedReason).toBe('SKILL_CALL_BUDGET_EXHAUSTED')
    expect(boundedCalls).toEqual(completeCalls.slice(0, 5))
  })
})
