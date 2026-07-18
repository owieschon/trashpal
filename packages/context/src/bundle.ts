import {
  ContextBundleSchema,
  ProgramDefinitionSchema,
  SkillDefinitionSchema,
  contentDigest,
} from '@trashpal/contracts'
import { z } from 'zod'

type ContextBundle = z.infer<typeof ContextBundleSchema>

const SourceCoverageSchema = z.object({
  requiredObjects: z.array(z.string().min(1)).min(1),
  observedObjects: z.array(z.string().min(1)).min(1),
  complete: z.boolean(),
  truncated: z.boolean(),
}).strict()

export const recordedSalesforceFieldMapping = {
  sourceId: 'Id',
  tenantId: 'Tenant_Key__c',
  evidenceId: 'Evidence_Key__c',
  modifiedAt: 'LastModifiedDate',
  caseId: 'Case.External_Case_Id__c',
  caseSiteId: 'Case.Service_Site__c',
  caseSubject: 'Case.Subject',
  caseDescription: 'Case.Description',
  agreementSiteId: 'Service_Agreement__c.Service_Site__c',
  agreementActive: 'Service_Agreement__c.Active__c',
  agreementStream: 'Service_Agreement__c.Stream__c',
  agreementRecoveryDeadline: 'Service_Agreement__c.Recovery_Deadline__c',
  agreementValidThrough: 'Service_Agreement__c.Valid_Through__c',
  commentCaseId: 'CaseComment.ParentId',
  accessStatus: 'CaseComment.Access_Status__c',
  accessValidFrom: 'CaseComment.Valid_From__c',
  accessValidUntil: 'CaseComment.Valid_Until__c',
  commentBody: 'CaseComment.CommentBody',
  attemptCaseId: 'Field_Service_Attempt__c.External_Case_Id__c',
  attemptStatus: 'Field_Service_Attempt__c.Status__c',
  attemptReason: 'Field_Service_Attempt__c.Reason__c',
  attemptObservedAt: 'Field_Service_Attempt__c.Observed_At__c',
  attemptAccessStatus: 'Field_Service_Attempt__c.Access_Status__c',
  attemptAccessValidFrom: 'Field_Service_Attempt__c.Access_Valid_From__c',
  attemptAccessValidUntil: 'Field_Service_Attempt__c.Access_Valid_Until__c',
  historyCaseId: 'CaseHistory.ParentId',
  historySummary: 'CaseHistory.Summary__c',
} as const

export const RecordedSalesforceFieldMappingSchema = z.object({
  sourceId: z.literal(recordedSalesforceFieldMapping.sourceId),
  tenantId: z.literal(recordedSalesforceFieldMapping.tenantId),
  evidenceId: z.literal(recordedSalesforceFieldMapping.evidenceId),
  modifiedAt: z.literal(recordedSalesforceFieldMapping.modifiedAt),
  caseId: z.literal(recordedSalesforceFieldMapping.caseId),
  caseSiteId: z.literal(recordedSalesforceFieldMapping.caseSiteId),
  caseSubject: z.literal(recordedSalesforceFieldMapping.caseSubject),
  caseDescription: z.literal(recordedSalesforceFieldMapping.caseDescription),
  agreementSiteId: z.literal(recordedSalesforceFieldMapping.agreementSiteId),
  agreementActive: z.literal(recordedSalesforceFieldMapping.agreementActive),
  agreementStream: z.literal(recordedSalesforceFieldMapping.agreementStream),
  agreementRecoveryDeadline: z.literal(recordedSalesforceFieldMapping.agreementRecoveryDeadline),
  agreementValidThrough: z.literal(recordedSalesforceFieldMapping.agreementValidThrough),
  commentCaseId: z.literal(recordedSalesforceFieldMapping.commentCaseId),
  accessStatus: z.literal(recordedSalesforceFieldMapping.accessStatus),
  accessValidFrom: z.literal(recordedSalesforceFieldMapping.accessValidFrom),
  accessValidUntil: z.literal(recordedSalesforceFieldMapping.accessValidUntil),
  commentBody: z.literal(recordedSalesforceFieldMapping.commentBody),
  attemptCaseId: z.literal(recordedSalesforceFieldMapping.attemptCaseId),
  attemptStatus: z.literal(recordedSalesforceFieldMapping.attemptStatus),
  attemptReason: z.literal(recordedSalesforceFieldMapping.attemptReason),
  attemptObservedAt: z.literal(recordedSalesforceFieldMapping.attemptObservedAt),
  attemptAccessStatus: z.literal(recordedSalesforceFieldMapping.attemptAccessStatus),
  attemptAccessValidFrom: z.literal(recordedSalesforceFieldMapping.attemptAccessValidFrom),
  attemptAccessValidUntil: z.literal(recordedSalesforceFieldMapping.attemptAccessValidUntil),
  historyCaseId: z.literal(recordedSalesforceFieldMapping.historyCaseId),
  historySummary: z.literal(recordedSalesforceFieldMapping.historySummary),
}).strict()

export const SourceMappingMetadataSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().regex(/^ten[-_][a-z0-9-]+$/),
  version: z.string().min(1),
  status: z.enum(['confirmed', 'unresolved']),
  verifiedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  coverage: SourceCoverageSchema,
  fields: RecordedSalesforceFieldMappingSchema,
}).strict()

export const RecoveryPolicyContractSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  rules: z.array(z.string().min(1)).min(1),
}).strict()

const StaticContextInputSchema = z.object({
  tenantId: z.string().regex(/^ten[-_][a-z0-9-]+$/),
  compiledAt: z.iso.datetime({ offset: true }),
  sourceMapping: SourceMappingMetadataSchema,
  policy: RecoveryPolicyContractSchema,
  program: ProgramDefinitionSchema,
  skills: z.array(SkillDefinitionSchema).min(1),
}).strict()

export interface CompiledStaticContext {
  bundle: ContextBundle
  sourceMapping: z.infer<typeof SourceMappingMetadataSchema>
  policy: z.infer<typeof RecoveryPolicyContractSchema>
  program: z.infer<typeof ProgramDefinitionSchema>
  skills: z.infer<typeof SkillDefinitionSchema>[]
}

export function compileStaticContext(input: z.input<typeof StaticContextInputSchema>): CompiledStaticContext {
  const value = StaticContextInputSchema.parse(input)
  if (value.sourceMapping.tenantId !== value.tenantId) throw new Error('SOURCE_MAPPING_TENANT_MISMATCH')
  if (value.sourceMapping.status !== 'confirmed') throw new Error('SOURCE_MAPPING_UNRESOLVED')
  if (!value.sourceMapping.coverage.complete || value.sourceMapping.coverage.truncated) {
    throw new Error('SOURCE_MAPPING_INCOMPLETE')
  }
  const observed = new Set(value.sourceMapping.coverage.observedObjects)
  if (value.sourceMapping.coverage.requiredObjects.some((object) => !observed.has(object))) {
    throw new Error('SOURCE_MAPPING_COVERAGE_GAP')
  }
  if (Date.parse(value.sourceMapping.validUntil) <= Date.parse(value.compiledAt)) {
    throw new Error('SOURCE_MAPPING_EXPIRED')
  }
  const definedSkills = new Map(value.skills.map((skill) => [skill.id, skill]))
  if (value.program.allowedSkills.some((skillId) => !definedSkills.has(skillId))) {
    throw new Error('PROGRAM_SKILL_UNMAPPED')
  }
  if (definedSkills.size !== value.program.allowedSkills.length) throw new Error('PROGRAM_SKILL_DRIFT')

  const unsigned = {
    id: `context_${value.tenantId}_${value.program.id}`,
    tenantId: value.tenantId,
    version: `${value.program.version}+${value.sourceMapping.version}+${value.policy.version}`,
    programVersion: value.program.version,
    policyVersion: value.policy.version,
    mappingVersion: value.sourceMapping.version,
    skillVersions: Object.fromEntries(value.skills.map((skill) => [skill.id, skill.version])),
    compiledAt: value.compiledAt,
  }
  const canonicalContracts = {
    tenantId: value.tenantId,
    sourceMapping: {
      ...value.sourceMapping,
      coverage: {
        ...value.sourceMapping.coverage,
        requiredObjects: [...value.sourceMapping.coverage.requiredObjects].sort(),
        observedObjects: [...value.sourceMapping.coverage.observedObjects].sort(),
      },
    },
    policy: value.policy,
    program: value.program,
    skills: [...value.skills].sort((left, right) => left.id.localeCompare(right.id)),
  }
  const bundle = ContextBundleSchema.parse({
    ...unsigned,
    hash: contentDigest({ bundle: unsigned, contracts: canonicalContracts }),
  })
  return {
    bundle,
    sourceMapping: value.sourceMapping,
    policy: value.policy,
    program: value.program,
    skills: value.skills,
  }
}
