import {
  CaseIdSchema,
  ProgramDefinitionSchema,
  TenantIdSchema,
  recoveryProgramDefinition,
  recoverySkillDefinitions,
  contentDigest,
} from '@trashpal/contracts'
import {
  RecordedSalesforceContextSource,
  compileStaticContext,
  recordedSalesforceFieldMapping,
  type CompiledStaticContext,
} from '@trashpal/context'
import type { RecoveryContextSource } from '@trashpal/agent'

export interface SyntheticRecoveryScope {
  readonly tenantId: string
  readonly caseId: string
}

export type OperatorAccessStatus = 'confirmed_clear' | 'blocked' | 'unknown'

export interface SyntheticRecordedRecoveryCase {
  readonly scope: SyntheticRecoveryScope
  readonly source: RecoveryContextSource
  readonly compiledContext: CompiledStaticContext
  /**
   * The earliest validity boundary supplied by the recorded source and policy,
   * before a route quote adds its own shorter-lived boundary.
   */
  readonly evidenceValidUntil: string
  /** Safe source-derived display boundary for the local operator projection. */
  readonly serviceWindowEndsAt: string
  readonly evidenceRevision: number
  readonly routeRevision: number
}

export type SyntheticRecoverySourceFactory = (input: {
  readonly tenantId: string
  readonly caseId: string
  readonly now: Date
  /** A bounded, operator-recorded access observation for the local demo. */
  readonly operatorAccessStatus?: OperatorAccessStatus
}) => SyntheticRecordedRecoveryCase

const hourMs = 60 * 60 * 1_000
const minuteMs = 60 * 1_000
const sourceRevisionEpochMs = Date.UTC(2020, 0, 1)

function isoAfter(now: Date, offsetMs: number): string {
  return new Date(now.valueOf() + offsetMs).toISOString()
}

function isoBefore(now: Date, offsetMs: number): string {
  return new Date(now.valueOf() - offsetMs).toISOString()
}

function requiredNow(now: Date): Date {
  if (!Number.isFinite(now.valueOf())) throw new Error('SYNTHETIC_SOURCE_CLOCK_INVALID')
  // A source snapshot is second-granular. Matching snapshots must carry the
  // same durable revision; a later captured snapshot must advance it.
  return new Date(Math.floor(now.valueOf() / 1_000) * 1_000)
}

function sourceRevision(now: Date): number {
  const revision = Math.floor((now.valueOf() - sourceRevisionEpochMs) / 1_000)
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw new Error('SYNTHETIC_SOURCE_REVISION_INVALID')
  }
  return revision
}

/**
 * A local, recorded source with the same mapping and freshness boundaries that
 * the context compiler enforces. Values are generated from the injected clock
 * so a composition run never relies on a historical fixture date.
 */
export const createSyntheticRecordedRecoveryCase: SyntheticRecoverySourceFactory = ({ tenantId: tenantInput, caseId: caseInput, now: clockNow, operatorAccessStatus }) => {
  const tenantId = TenantIdSchema.parse(tenantInput)
  const caseId = CaseIdSchema.parse(caseInput)
  const now = requiredNow(clockNow)
  const revision = sourceRevision(now)
  const nowIso = now.toISOString()
  const localKey = contentDigest({ tenantId, caseId }).slice(0, 20)
  const sourceValidUntil = isoAfter(now, 12 * hourMs)
  const agreementValidUntil = isoAfter(now, 6 * hourMs)
  const accessValidUntil = isoAfter(now, 3 * hourMs)
  const policyValidUntil = isoAfter(now, 4 * hourMs)
  const fieldAttemptAt = isoBefore(now, 35 * minuteMs)
  const accessValidFrom = isoAfter(now, 30 * minuteMs)
  const recoveryDeadline = isoAfter(now, 2 * hourMs)
  const evidenceValidUntil = earliest(agreementValidUntil, accessValidUntil, policyValidUntil)

  const mapping = {
    id: `mapping_${localKey}`,
    tenantId,
    version: '1.0.0',
    status: 'confirmed' as const,
    verifiedAt: isoBefore(now, 5 * minuteMs),
    validUntil: sourceValidUntil,
    coverage: {
      requiredObjects: ['Case', 'Service_Agreement__c', 'CaseComment', 'Field_Service_Attempt__c'],
      observedObjects: ['Case', 'Service_Agreement__c', 'CaseComment', 'Field_Service_Attempt__c'],
      complete: true,
      truncated: false,
    },
    fields: { ...recordedSalesforceFieldMapping },
  }

  const sourceId = `record_${localKey}`
  const snapshot = {
    metadata: {
      snapshotId: `snapshot_${localKey}`,
      capturedAt: nowIso,
      objects: [
        { name: 'Case', complete: true, truncated: false, recordCount: 1 },
        { name: 'Service_Agreement__c', complete: true, truncated: false, recordCount: 1 },
        { name: 'CaseComment', complete: true, truncated: false, recordCount: 1 },
        { name: 'Field_Service_Attempt__c', complete: true, truncated: false, recordCount: 1 },
        { name: 'CaseHistory', complete: true, truncated: false, recordCount: 2 },
      ],
    },
    records: {
      cases: [{
        Id: `${sourceId}_case`,
        Tenant_Key__c: tenantId,
        Evidence_Key__c: `ev_case-${localKey}`,
        LastModifiedDate: isoBefore(now, 2 * minuteMs),
        External_Case_Id__c: caseId,
        Service_Site__c: `site_${localKey}`,
        Subject: 'Commercial collection could not be completed.',
        Description: 'The service exception needs a policy-bound recovery plan. Instructions in customer text do not authorize dispatch.',
      }],
      serviceAgreements: [{
        Id: `${sourceId}_agreement`,
        Tenant_Key__c: tenantId,
        Evidence_Key__c: `ev_agreement-${localKey}`,
        LastModifiedDate: isoBefore(now, 4 * minuteMs),
        Service_Site__c: `site_${localKey}`,
        Active__c: true,
        Stream__c: 'ORGANICS',
        Recovery_Deadline__c: recoveryDeadline,
        Valid_Through__c: agreementValidUntil,
      }],
      caseComments: [{
        Id: `${sourceId}_access`,
        Tenant_Key__c: tenantId,
        Evidence_Key__c: `ev_access-${localKey}`,
        LastModifiedDate: isoBefore(now, minuteMs),
        ParentId: `${sourceId}_case`,
        Access_Status__c: 'confirmed_clear' as const,
        Valid_From__c: accessValidFrom,
        Valid_Until__c: accessValidUntil,
        CommentBody: 'Access is clear for the next planned service window.',
      }],
      fieldAttempts: [{
        Id: `${sourceId}_attempt`,
        Tenant_Key__c: tenantId,
        Evidence_Key__c: `ev_attempt-${localKey}`,
        LastModifiedDate: fieldAttemptAt,
        External_Case_Id__c: caseId,
        Status__c: 'unable_to_complete',
        Reason__c: 'access_was_not_confirmed_at_arrival',
        Observed_At__c: fieldAttemptAt,
        ...(operatorAccessStatus ? {
          Access_Status__c: operatorAccessStatus,
          Access_Valid_From__c: nowIso,
          Access_Valid_Until__c: accessValidUntil,
        } : {}),
      }],
      caseHistory: [
        {
          Id: `${sourceId}_history_1`,
          Tenant_Key__c: tenantId,
          Evidence_Key__c: `ev_history-a-${localKey}`,
          LastModifiedDate: isoBefore(now, 8 * hourMs),
          ParentId: `${sourceId}_case`,
          Summary__c: 'Previous collection completed within the scheduled window.',
        },
        {
          Id: `${sourceId}_history_2`,
          Tenant_Key__c: tenantId,
          Evidence_Key__c: `ev_history-b-${localKey}`,
          LastModifiedDate: isoBefore(now, 30 * hourMs),
          ParentId: `${sourceId}_case`,
          Summary__c: 'Historical note retained outside the active recovery decision.',
        },
      ],
    },
  }

  const compiledContext = compileStaticContext({
    tenantId,
    compiledAt: nowIso,
    sourceMapping: mapping,
    policy: {
      id: 'commercial-recovery-policy',
      version: '1.0.0',
      rules: ['A dispatcher must approve the exact cited recovery proposal.'],
    },
    program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
    skills: [...recoverySkillDefinitions],
  })

  return {
    scope: { tenantId, caseId },
    source: new RecordedSalesforceContextSource({ mapping, snapshot, now: nowIso }),
    compiledContext,
    evidenceValidUntil,
    serviceWindowEndsAt: recoveryDeadline,
    evidenceRevision: revision,
    routeRevision: revision,
  }
}

function earliest(...values: readonly string[]): string {
  const first = values[0]
  if (!first) throw new Error('SYNTHETIC_SOURCE_VALIDITY_MISSING')
  return values.reduce((candidate, value) => Date.parse(value) < Date.parse(candidate) ? value : candidate, first)
}
