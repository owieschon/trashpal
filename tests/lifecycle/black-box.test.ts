import { describe, expect, it } from 'vitest'
import { digest } from '../../packages/lifecycle/src/index.js'
import { executeLifecycleScenario } from '../../packages/lifecycle/src/black-box.mjs'

describe('lifecycle black-box adapter', () => {
  it('reports the full evidence lifecycle without inferring confirmation', () => {
    const binding = {
      proposalDigest: digest('proposal'),
      evidenceDigest: digest('evidence'),
      quoteDigest: digest('quote'),
    }
    const result = executeLifecycleScenario({
      schemaVersion: '1.0',
      operationId: 'opaque-operation',
      binding,
      events: [
        { type: 'approve', binding },
        { type: 'dispatch_ack_lost', idempotencyKey: 'opaque-key' },
        { type: 'reconcile_assignment_found' },
        { type: 'driver_reported_complete' },
        { type: 'supporting_attachment_received', attachmentId: 'attachment-1' },
        { type: 'evidence_reconciled' },
      ],
    })
    expect(result.states).toEqual([
      'approved',
      'unknown',
      'assignment_reconciled',
      'driver_reported',
      'supporting_evidence_received',
      'evidence_reconciled',
    ])
    expect(result.finalState).not.toBe('customer_confirmed')
  })

  it('rejects an execution whose quote binding changed after approval', () => {
    const binding = {
      proposalDigest: digest('proposal'),
      evidenceDigest: digest('evidence'),
      quoteDigest: digest('quote'),
    }
    const result = executeLifecycleScenario({
      schemaVersion: '1.0',
      operationId: 'opaque-operation',
      binding,
      events: [
        { type: 'approve', binding },
        { type: 'execute', binding: { ...binding, quoteDigest: digest('tampered') } },
      ],
    })
    expect(result).toMatchObject({ accepted: false, reason: 'binding_mismatch' })
  })

  it('rejects a changed binding at approval', () => {
    const binding = {
      proposalDigest: digest('proposal'),
      evidenceDigest: digest('evidence'),
      quoteDigest: digest('quote'),
    }
    const result = executeLifecycleScenario({
      schemaVersion: '1.0',
      operationId: 'opaque-operation',
      binding,
      events: [{ type: 'approve', binding: { ...binding, evidenceDigest: digest('tampered') } }],
    })
    expect(result).toMatchObject({ accepted: false, reason: 'binding_mismatch' })
  })
})
