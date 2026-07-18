import { EvidenceItemSchema, contentDigest } from '@trashpal/contracts'
import { z } from 'zod'
import { SourceMappingMetadataSchema } from './bundle.js'

const ScopeSchema = z.object({
  tenantId: z.string().regex(/^ten[-_][a-z0-9-]+$/),
  caseId: z.string().regex(/^case[-_][a-z0-9-]+$/),
}).strict()

const CommonRecordSchema = z.object({
  Id: z.string().min(1),
  Tenant_Key__c: z.string().min(1),
  Evidence_Key__c: z.string().regex(/^ev[-_][a-z0-9-]+$/),
  LastModifiedDate: z.iso.datetime({ offset: true }),
}).strict()

const CaseRecordSchema = CommonRecordSchema.extend({
  External_Case_Id__c: z.string().regex(/^case[-_][a-z0-9-]+$/),
  Service_Site__c: z.string().min(1),
  Subject: z.string().min(1),
  Description: z.string(),
}).strict()

const AgreementRecordSchema = CommonRecordSchema.extend({
  Service_Site__c: z.string().min(1),
  Active__c: z.boolean(),
  Stream__c: z.string().min(1),
  Recovery_Deadline__c: z.iso.datetime({ offset: true }),
  Valid_Through__c: z.iso.datetime({ offset: true }),
}).strict()

const CaseCommentSchema = CommonRecordSchema.extend({
  ParentId: z.string().min(1),
  Access_Status__c: z.enum(['confirmed_clear', 'blocked', 'unknown']),
  Valid_From__c: z.iso.datetime({ offset: true }),
  Valid_Until__c: z.iso.datetime({ offset: true }),
  CommentBody: z.string(),
}).strict()

const FieldAttemptSchema = CommonRecordSchema.extend({
  External_Case_Id__c: z.string().regex(/^case[-_][a-z0-9-]+$/),
  Status__c: z.string().min(1),
  Reason__c: z.string().min(1),
  Observed_At__c: z.iso.datetime({ offset: true }),
  Access_Status__c: z.enum(['confirmed_clear', 'blocked', 'unknown']).optional(),
  Access_Valid_From__c: z.iso.datetime({ offset: true }).optional(),
  Access_Valid_Until__c: z.iso.datetime({ offset: true }).optional(),
}).strict()

const HistoryRecordSchema = CommonRecordSchema.extend({
  ParentId: z.string().min(1),
  Summary__c: z.string().min(1),
}).strict()

export const RecordedSalesforceSnapshotSchema = z.object({
  metadata: z.object({
    snapshotId: z.string().min(1),
    capturedAt: z.iso.datetime({ offset: true }),
    objects: z.array(z.object({
      name: z.string().min(1),
      complete: z.boolean(),
      truncated: z.boolean(),
      recordCount: z.number().int().nonnegative(),
    }).strict()).min(1),
  }).strict(),
  records: z.object({
    cases: z.array(CaseRecordSchema),
    serviceAgreements: z.array(AgreementRecordSchema),
    caseComments: z.array(CaseCommentSchema),
    fieldAttempts: z.array(FieldAttemptSchema),
    caseHistory: z.array(HistoryRecordSchema),
  }).strict(),
}).strict()

type RecordedSnapshot = z.infer<typeof RecordedSalesforceSnapshotSchema>
type SourceMapping = z.infer<typeof SourceMappingMetadataSchema>
type EvidenceItem = z.infer<typeof EvidenceItemSchema>
export type CaseScope = z.infer<typeof ScopeSchema>

export interface ServiceExceptionInspection {
  caseEvidence: EvidenceItem
  candidateEvidence: Array<{ evidenceId: string; reason: string }>
  optionalEvidenceResidualCount: number
}

const MAX_OPTIONAL_EVIDENCE_DESCRIPTORS = 64

function freshness(expiresAt: string, now: string): 'fresh' | 'stale' {
  return Date.parse(expiresAt) > Date.parse(now) ? 'fresh' : 'stale'
}

function evidence(input: {
  id: string
  tenantId: string
  sourceId: string
  caseId: string
  observedAt: string
  authority: 'agreement' | 'field_operation' | 'customer_report'
  classification: 'trusted' | 'untrusted_content'
  freshness: 'fresh' | 'stale'
  content: Record<string, unknown>
}): EvidenceItem {
  const content = { caseId: input.caseId, ...input.content }
  return EvidenceItemSchema.parse({ ...input, content, contentHash: contentDigest(content) })
}

function assertSourceIdentity(snapshot: RecordedSnapshot, tenantId: string): void {
  const tenantRecords = Object.values(snapshot.records)
    .flat()
    .filter((record) => record.Tenant_Key__c === tenantId)
  const sourceIds = new Set<string>()
  const evidenceIds = new Set<string>()
  for (const record of tenantRecords) {
    if (sourceIds.has(record.Id) || evidenceIds.has(record.Evidence_Key__c)) {
      throw new Error('SOURCE_IDENTITY_CONFLICT')
    }
    sourceIds.add(record.Id)
    evidenceIds.add(record.Evidence_Key__c)
  }
  for (const attempt of snapshot.records.fieldAttempts.filter((record) => record.Tenant_Key__c === tenantId)) {
    if (attempt.Access_Status__c && evidenceIds.has(`${attempt.Evidence_Key__c}-access`)) {
      throw new Error('SOURCE_IDENTITY_CONFLICT')
    }
    if (attempt.Access_Status__c) evidenceIds.add(`${attempt.Evidence_Key__c}-access`)
  }

  const caseIds = new Set<string>()
  const activeAgreementSites = new Set<string>()
  for (const agreement of snapshot.records.serviceAgreements.filter((record) =>
    record.Tenant_Key__c === tenantId && record.Active__c,
  )) {
    if (activeAgreementSites.has(agreement.Service_Site__c)) throw new Error('SOURCE_IDENTITY_CONFLICT')
    activeAgreementSites.add(agreement.Service_Site__c)
  }
  for (const record of snapshot.records.cases.filter((item) => item.Tenant_Key__c === tenantId)) {
    if (caseIds.has(record.External_Case_Id__c)) throw new Error('SOURCE_IDENTITY_CONFLICT')
    caseIds.add(record.External_Case_Id__c)
  }

  const attemptsByCase = new Map<string, Array<z.infer<typeof FieldAttemptSchema>>>()
  for (const attempt of snapshot.records.fieldAttempts.filter((record) => record.Tenant_Key__c === tenantId)) {
    const attempts = attemptsByCase.get(attempt.External_Case_Id__c) ?? []
    attempts.push(attempt)
    attemptsByCase.set(attempt.External_Case_Id__c, attempts)
  }
  for (const attempts of attemptsByCase.values()) {
    const latest = Math.max(...attempts.map((attempt) => Date.parse(attempt.Observed_At__c)))
    if (attempts.filter((attempt) => Date.parse(attempt.Observed_At__c) === latest).length > 1) {
      throw new Error('SOURCE_IDENTITY_CONFLICT')
    }
  }
}

export class RecordedSalesforceContextSource {
  readonly mapping: SourceMapping
  readonly snapshot: RecordedSnapshot
  readonly now: string

  constructor(input: { mapping: SourceMapping; snapshot: RecordedSnapshot; now: string }) {
    this.mapping = SourceMappingMetadataSchema.parse(input.mapping)
    this.snapshot = RecordedSalesforceSnapshotSchema.parse(input.snapshot)
    this.now = z.iso.datetime({ offset: true }).parse(input.now)
    assertSourceIdentity(this.snapshot, this.mapping.tenantId)
  }

  inspectServiceException(scopeInput: CaseScope, _signal?: AbortSignal): ServiceExceptionInspection {
    const { scope, caseRecord } = this.resolveCase(scopeInput)
    const caseEvidence = evidence({
      id: caseRecord.Evidence_Key__c,
      tenantId: scope.tenantId,
      sourceId: caseRecord.Id,
      caseId: scope.caseId,
      observedAt: caseRecord.LastModifiedDate,
      authority: 'customer_report',
      classification: 'untrusted_content',
      freshness: freshness(new Date(Date.parse(caseRecord.LastModifiedDate) + 86_400_000).toISOString(), this.now),
      content: {
        siteId: caseRecord.Service_Site__c,
        reportedIssue: caseRecord.Subject,
        customerDescription: caseRecord.Description,
        validUntil: new Date(Date.parse(caseRecord.LastModifiedDate) + 86_400_000).toISOString(),
      },
    })
    const optionalHistory = this.snapshot.records.caseHistory
      .filter((record) => record.Tenant_Key__c === scope.tenantId && record.ParentId === caseRecord.Id)
    const candidateEvidence = [
      ...this.snapshot.records.serviceAgreements
        .filter((record) => record.Tenant_Key__c === scope.tenantId && record.Service_Site__c === caseRecord.Service_Site__c)
        .map((record) => ({ evidenceId: record.Evidence_Key__c, reason: 'The agreement is loaded only if the recovery commitment is needed.' })),
      ...this.snapshot.records.caseComments
        .filter((record) => record.Tenant_Key__c === scope.tenantId && record.ParentId === caseRecord.Id)
        .map((record) => ({ evidenceId: record.Evidence_Key__c, reason: 'Access evidence is loaded only after a current agreement is found.' })),
      ...this.snapshot.records.fieldAttempts
        .filter((record) => record.Tenant_Key__c === scope.tenantId && record.External_Case_Id__c === scope.caseId)
        .flatMap((record) => [
          { evidenceId: record.Evidence_Key__c, reason: 'The field attempt is loaded only after access evidence is inspected.' },
          ...(record.Access_Status__c
            ? [{ evidenceId: `${record.Evidence_Key__c}-access`, reason: 'The field access observation is loaded with access evidence.' }]
            : []),
        ]),
      ...optionalHistory.slice(0, MAX_OPTIONAL_EVIDENCE_DESCRIPTORS).map((record) => ({
        evidenceId: record.Evidence_Key__c,
        reason: 'Archived history is outside the current exception decision window.',
      })),
    ]
    return {
      caseEvidence,
      candidateEvidence,
      optionalEvidenceResidualCount: Math.max(0, optionalHistory.length - MAX_OPTIONAL_EVIDENCE_DESCRIPTORS),
    }
  }

  getCustomerCommitments(scopeInput: CaseScope, _signal?: AbortSignal): EvidenceItem | null {
    const { scope, caseRecord } = this.resolveCase(scopeInput)
    const tenantAgreements = this.snapshot.records.serviceAgreements.filter((record) =>
      record.Tenant_Key__c === scope.tenantId && record.Active__c,
    )
    const matchingAgreements = tenantAgreements.filter((record) => record.Service_Site__c === caseRecord.Service_Site__c)
    if (matchingAgreements.length > 1 || (matchingAgreements.length === 0 && tenantAgreements.length > 0)) {
      throw new Error('SOURCE_IDENTITY_CONFLICT')
    }
    const agreement = matchingAgreements[0]
    if (!agreement) return null
    return evidence({
      id: agreement.Evidence_Key__c,
      tenantId: scope.tenantId,
      sourceId: agreement.Id,
      caseId: scope.caseId,
      observedAt: agreement.LastModifiedDate,
      authority: 'agreement',
      classification: 'trusted',
      freshness: freshness(agreement.Valid_Through__c, this.now),
      content: {
        siteId: agreement.Service_Site__c,
        stream: agreement.Stream__c,
        recoveryDeadline: agreement.Recovery_Deadline__c,
        validUntil: agreement.Valid_Through__c,
      },
    })
  }

  getAccessEvidence(scopeInput: CaseScope, _signal?: AbortSignal): EvidenceItem[] {
    const { scope, caseRecord } = this.resolveCase(scopeInput)
    const customerEvidence = this.snapshot.records.caseComments
      .filter((record) => record.Tenant_Key__c === scope.tenantId && record.ParentId === caseRecord.Id)
      .map((record) => evidence({
        id: record.Evidence_Key__c,
        tenantId: scope.tenantId,
        sourceId: record.Id,
        caseId: scope.caseId,
        observedAt: record.LastModifiedDate,
        authority: 'customer_report',
        classification: 'untrusted_content',
        freshness: freshness(record.Valid_Until__c, this.now),
        content: {
          status: record.Access_Status__c,
          validFrom: record.Valid_From__c,
          validUntil: record.Valid_Until__c,
          customerContent: record.CommentBody,
        },
      }))
    const fieldEvidence = this.snapshot.records.fieldAttempts
      .filter((record) => record.Tenant_Key__c === scope.tenantId
        && record.External_Case_Id__c === scope.caseId
        && record.Access_Status__c !== undefined)
      .map((record) => {
        const validFrom = record.Access_Valid_From__c ?? record.Observed_At__c
        const validUntil = record.Access_Valid_Until__c
          ?? new Date(Date.parse(record.Observed_At__c) + 3_600_000).toISOString()
        return evidence({
          id: `${record.Evidence_Key__c}-access`,
          tenantId: scope.tenantId,
          sourceId: record.Id,
          caseId: scope.caseId,
          observedAt: record.Observed_At__c,
          authority: 'field_operation',
          classification: 'trusted',
          freshness: freshness(validUntil, this.now),
          content: { status: record.Access_Status__c, validFrom, validUntil },
        })
      })
    return [...customerEvidence, ...fieldEvidence]
  }

  getFieldAttempt(scopeInput: CaseScope, _signal?: AbortSignal): EvidenceItem | null {
    const { scope } = this.resolveCase(scopeInput)
    const attempts = this.snapshot.records.fieldAttempts
      .filter((record) => record.Tenant_Key__c === scope.tenantId && record.External_Case_Id__c === scope.caseId)
      .sort((left, right) => Date.parse(right.Observed_At__c) - Date.parse(left.Observed_At__c))
    const attempt = attempts[0]
    if (!attempt) return null
    return evidence({
      id: attempt.Evidence_Key__c,
      tenantId: scope.tenantId,
      sourceId: attempt.Id,
      caseId: scope.caseId,
      observedAt: attempt.Observed_At__c,
      authority: 'field_operation',
      classification: 'trusted',
      freshness: freshness(new Date(Date.parse(attempt.Observed_At__c) + 86_400_000).toISOString(), this.now),
      content: {
        status: attempt.Status__c,
        reason: attempt.Reason__c,
        validUntil: new Date(Date.parse(attempt.Observed_At__c) + 86_400_000).toISOString(),
      },
    })
  }

  private resolveCase(scopeInput: CaseScope) {
    const scope = ScopeSchema.parse(scopeInput)
    this.assertReadable()
    if (scope.tenantId !== this.mapping.tenantId) throw new Error('TENANT_SCOPE_VIOLATION')
    const matchingCases = this.snapshot.records.cases.filter((record) =>
      record.Tenant_Key__c === scope.tenantId && record.External_Case_Id__c === scope.caseId,
    )
    if (matchingCases.length > 1) throw new Error('SOURCE_IDENTITY_CONFLICT')
    const caseRecord = matchingCases[0]
    if (!caseRecord) throw new Error('CASE_NOT_FOUND_IN_SCOPE')
    return { scope, caseRecord }
  }

  private assertReadable(): void {
    if (this.mapping.status !== 'confirmed') throw new Error('SOURCE_MAPPING_UNRESOLVED')
    if (Date.parse(this.mapping.validUntil) <= Date.parse(this.now)) throw new Error('SOURCE_MAPPING_EXPIRED')
    if (!this.mapping.coverage.complete || this.mapping.coverage.truncated) throw new Error('SOURCE_MAPPING_INCOMPLETE')
    if (this.snapshot.metadata.objects.some((object) => !object.complete || object.truncated)) {
      throw new Error('RECORDED_SNAPSHOT_INCOMPLETE')
    }
  }
}
