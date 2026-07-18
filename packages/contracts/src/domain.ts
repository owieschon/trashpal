import { createHash } from 'node:crypto'
import { z } from 'zod'

const brandedId = <T extends string>(prefix: string) => z.string().regex(new RegExp(`^${prefix}[-_][a-z0-9-]+$`)).brand<T>()

export const TenantIdSchema = brandedId<'TenantId'>('ten')
export const CaseIdSchema = brandedId<'CaseId'>('case')
export const EvidenceIdSchema = brandedId<'EvidenceId'>('ev')
export const RouteQuoteIdSchema = brandedId<'RouteQuoteId'>('quote')
export const ProposalIdSchema = brandedId<'ProposalId'>('proposal')
export const OperationIdSchema = brandedId<'OperationId'>('op')

export const AuthoritySchema = z.enum(['agreement', 'field_operation', 'customer_report', 'policy', 'derived'])
export const ClassificationSchema = z.enum(['trusted', 'untrusted_content', 'derived'])
export const FreshnessSchema = z.enum(['fresh', 'stale', 'unknown'])

export const EvidenceItemSchema = z.object({
  id: EvidenceIdSchema,
  tenantId: TenantIdSchema,
  sourceId: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  authority: AuthoritySchema,
  classification: ClassificationSchema,
  freshness: FreshnessSchema,
  content: z.record(z.string(), z.unknown()),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
})

export const ContextBundleSchema = z.object({
  id: z.string().min(1),
  tenantId: TenantIdSchema,
  version: z.string().min(1),
  programVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  mappingVersion: z.string().min(1),
  skillVersions: z.record(z.string(), z.string()),
  compiledAt: z.iso.datetime({ offset: true }),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
})

export const EvidenceConflictSchema = z.object({
  evidenceIds: z.array(EvidenceIdSchema).min(2),
  reason: z.string().min(1),
  unresolved: z.boolean(),
})

export const EvidencePacketSchema = z.object({
  id: z.string().min(1),
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  asOf: z.iso.datetime({ offset: true }),
  items: z.array(EvidenceItemSchema),
  conflicts: z.array(EvidenceConflictSchema),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
})

export const RouteQuoteSchema = z.object({
  id: RouteQuoteIdSchema,
  tenantId: TenantIdSchema,
  vehicleId: z.string().min(1),
  serviceStart: z.iso.datetime({ offset: true }),
  serviceEnd: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  remainingCapacityKg: z.number().nonnegative(),
  incrementalMinutes: z.number().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
})

export const RecoveryProposalSchema = z.object({
  id: ProposalIdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  outcome: z.enum(['prepare_recovery', 'hold_for_confirmation', 'escalate']),
  factualClaims: z.array(z.object({ text: z.string().min(1), evidenceIds: z.array(EvidenceIdSchema).min(1) })),
  routeQuoteId: RouteQuoteIdSchema.optional(),
  workOrder: z.object({
    vehicleId: z.string().min(1),
    serviceStart: z.iso.datetime({ offset: true }),
    serviceEnd: z.iso.datetime({ offset: true }),
  }).optional(),
  validUntil: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})

export const ApprovalBindingSchema = z.object({
  tenantId: TenantIdSchema,
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contextBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidencePacketHash: z.string().regex(/^[a-f0-9]{64}$/),
  routeQuoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  approverId: z.string().min(1),
  capability: z.literal('approve_recovery'),
  approvedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})

export const ExecutionSnapshotSchema = z.object({
  operationId: OperationIdSchema,
  tenantId: TenantIdSchema,
  proposalDigest: z.string().length(64),
  approvalDigest: z.string().length(64),
  evidenceRevision: z.number().int().nonnegative(),
  routeQuoteHash: z.string().length(64),
  vehicleId: z.string().min(1),
  serviceStart: z.iso.datetime({ offset: true }),
  serviceEnd: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().uuid(),
  digest: z.string().length(64),
})

export const OperationStateSchema = z.enum([
  'reserved',
  'sending',
  'accepted',
  'unknown',
  'assignment_reconciled',
  'driver_reported',
  'supporting_evidence_received',
  'evidence_reconciled',
  'customer_confirmed',
  'disputed',
  'reopened',
  'cancelled',
  'failed',
])

export const DispatchOperationSchema = z.object({
  id: OperationIdSchema,
  tenantId: TenantIdSchema,
  snapshot: ExecutionSnapshotSchema,
  state: OperationStateSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

export const OutcomeReceiptSchema = z.object({
  operationId: OperationIdSchema,
  tenantId: TenantIdSchema,
  state: OperationStateSchema,
  evidenceIds: z.array(EvidenceIdSchema),
  contextBundleHash: z.string().length(64),
  evidencePacketHash: z.string().length(64),
  routeQuoteHash: z.string().length(64),
  proposalDigest: z.string().length(64),
  approvalDigest: z.string().length(64),
  executionSnapshotDigest: z.string().length(64),
  recordedAt: z.iso.datetime({ offset: true }),
  digest: z.string().length(64),
})

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortCanonical(item)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value))
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function earliestValidityBoundary(values: readonly string[]): string {
  if (values.length === 0) throw new Error('at least one validity boundary is required')
  return values.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest)
}

export const allowedOutcomeTransitions: Readonly<Record<z.infer<typeof OperationStateSchema>, readonly z.infer<typeof OperationStateSchema>[]>> = {
  reserved: ['sending', 'cancelled'],
  sending: ['accepted', 'unknown', 'failed'],
  accepted: ['driver_reported', 'unknown'],
  unknown: ['assignment_reconciled', 'failed'],
  assignment_reconciled: ['driver_reported'],
  driver_reported: ['supporting_evidence_received', 'evidence_reconciled', 'disputed'],
  supporting_evidence_received: ['evidence_reconciled', 'disputed'],
  evidence_reconciled: ['customer_confirmed', 'disputed'],
  customer_confirmed: ['disputed'],
  disputed: ['reopened'],
  reopened: ['reserved', 'cancelled'],
  cancelled: [],
  failed: [],
}
