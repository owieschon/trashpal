import { describe, expect, it } from 'vitest'
import {
  ProgramDefinitionSchema,
  recoveryProgramDefinition,
  recoverySkillDefinitions,
} from '../../packages/contracts/src/index.js'
import {
  RecordedSalesforceContextSource,
  assembleModelContext,
  compileStaticContext,
} from '../../packages/context/src/index.js'
import { compileTestContext, fixedNow, makeMapping, makeSnapshot, makeSource } from './fixtures.js'

describe('static context compilation', () => {
  it('contains setup contracts and no dynamic customer or case data', () => {
    const compiled = compileTestContext()
    const serialized = JSON.stringify(compiled)
    expect(compiled.bundle.mappingVersion).toBe('1.0.0')
    expect(compiled.bundle.skillVersions).toHaveProperty('quote_recovery_options', '1.0.0')
    expect(serialized).not.toContain('case_0881')
    expect(serialized).not.toContain('Greenleaf')
    expect(serialized).not.toContain('veh_v42')
  })

  it('changes the bundle hash when canonical contract content changes without a version bump', () => {
    const original = compileTestContext()
    const mapping = makeMapping()
    mapping.validUntil = '2026-08-22T12:00:00-05:00'
    const changedMapping = compileStaticContext({
      tenantId: 'ten_harborworks',
      compiledAt: fixedNow,
      sourceMapping: mapping,
      policy: { id: 'commercial-recovery-policy', version: '1.0.0', rules: ['A dispatcher must approve the exact cited recovery proposal.'] },
      program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
      skills: [...recoverySkillDefinitions],
    })
    const changedPolicy = compileStaticContext({
      tenantId: 'ten_harborworks',
      compiledAt: fixedNow,
      sourceMapping: makeMapping(),
      policy: { id: 'commercial-recovery-policy', version: '1.0.0', rules: ['A supervisor must approve the exact cited recovery proposal.'] },
      program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
      skills: [...recoverySkillDefinitions],
    })
    const changedSkills = compileStaticContext({
      tenantId: 'ten_harborworks',
      compiledAt: fixedNow,
      sourceMapping: makeMapping(),
      policy: { id: 'commercial-recovery-policy', version: '1.0.0', rules: ['A dispatcher must approve the exact cited recovery proposal.'] },
      program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
      skills: recoverySkillDefinitions.map((skill) => skill.id === 'get_access_evidence'
        ? { ...skill, description: 'Read overlapping access observations with authority and freshness.' }
        : skill),
    })
    expect(new Set([original.bundle.hash, changedMapping.bundle.hash, changedPolicy.bundle.hash, changedSkills.bundle.hash]).size).toBe(4)
  })

  it.each([
    ['unresolved mapping', (mapping: ReturnType<typeof makeMapping>) => { mapping.status = 'unresolved' as 'confirmed' }],
    ['truncated coverage', (mapping: ReturnType<typeof makeMapping>) => { mapping.coverage.truncated = true }],
    ['expired mapping', (mapping: ReturnType<typeof makeMapping>) => { mapping.validUntil = fixedNow }],
    ['mismatched field mapping', (mapping: ReturnType<typeof makeMapping>) => {
      ;(mapping.fields as Record<string, string>).caseSiteId = 'Case.Alternate_Site__c'
    }],
  ])('fails closed for %s', (_label, mutate) => {
    const mapping = makeMapping()
    mutate(mapping)
    expect(() => compileStaticContext({
      tenantId: 'ten_harborworks',
      compiledAt: fixedNow,
      sourceMapping: mapping,
      policy: { id: 'policy', version: '1', rules: ['Human approval is required.'] },
      program: ProgramDefinitionSchema.parse(recoveryProgramDefinition),
      skills: [...recoverySkillDefinitions],
    })).toThrow()
  })
})

describe('recorded Salesforce context source', () => {
  it('maps only the requested tenant and case and labels customer text as untrusted', () => {
    const source = makeSource()
    const inspection = source.inspectServiceException({ tenantId: 'ten_harborworks', caseId: 'case_0881' })
    const access = source.getAccessEvidence({ tenantId: 'ten_harborworks', caseId: 'case_0881' })
    expect(inspection.candidateEvidence).toHaveLength(15)
    expect(access[0]?.classification).toBe('untrusted_content')
    expect(access[0]?.content.customerContent).toContain('Ignore policy')
    expect(() => source.inspectServiceException({ tenantId: 'ten_other', caseId: 'case_0881' })).toThrow('TENANT_SCOPE_VIOLATION')
  })

  it('fails closed instead of merging a case and agreement with different site identities', () => {
    const snapshot = makeSnapshot()
    snapshot.records.serviceAgreements[0]!.Service_Site__c = 'site_other'
    const source = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot, now: fixedNow })
    expect(() => source.getCustomerCommitments({ tenantId: 'ten_harborworks', caseId: 'case_0881' }))
      .toThrow('SOURCE_IDENTITY_CONFLICT')
  })

  it('marks an expired agreement stale', () => {
    const snapshot = makeSnapshot()
    snapshot.records.serviceAgreements[0]!.Valid_Through__c = '2026-07-21T13:19:59-05:00'
    const source = new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot, now: fixedNow })
    expect(source.getCustomerCommitments({ tenantId: 'ten_harborworks', caseId: 'case_0881' })?.freshness).toBe('stale')
  })

  it('rejects ambiguous source identity independent of record order', () => {
    const duplicateCase = { ...makeSnapshot().records.cases[0]!, Id: '500CASE-DUP', Evidence_Key__c: 'ev-case-dup' }
    const duplicateAgreement = {
      ...makeSnapshot().records.serviceAgreements[0]!,
      Id: 'a01AGREEMENT-DUP',
      Evidence_Key__c: 'ev-agreement-dup',
    }
    for (const reverse of [false, true]) {
      const cases = makeSnapshot()
      cases.records.cases.push(duplicateCase)
      if (reverse) cases.records.cases.reverse()
      expect(() => new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: cases, now: fixedNow }))
        .toThrow('SOURCE_IDENTITY_CONFLICT')

      const agreements = makeSnapshot()
      agreements.records.serviceAgreements.push(duplicateAgreement)
      if (reverse) agreements.records.serviceAgreements.reverse()
      expect(() => new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: agreements, now: fixedNow }))
        .toThrow('SOURCE_IDENTITY_CONFLICT')
    }
  })

  it('rejects duplicate source or evidence identity', () => {
    const duplicateSource = makeSnapshot()
    duplicateSource.records.caseComments[0]!.Id = duplicateSource.records.cases[0]!.Id
    expect(() => new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: duplicateSource, now: fixedNow }))
      .toThrow('SOURCE_IDENTITY_CONFLICT')

    const duplicateEvidence = makeSnapshot()
    duplicateEvidence.records.caseComments[0]!.Evidence_Key__c = duplicateEvidence.records.cases[0]!.Evidence_Key__c
    expect(() => new RecordedSalesforceContextSource({ mapping: makeMapping(), snapshot: duplicateEvidence, now: fixedNow }))
      .toThrow('SOURCE_IDENTITY_CONFLICT')
  })
})

describe('context assembly', () => {
  it('retains required evidence and explains omitted noise', () => {
    const source = makeSource()
    const scope = { tenantId: 'ten_harborworks', caseId: 'case_0881' }
    const inspection = source.inspectServiceException(scope)
    const agreement = source.getCustomerCommitments(scope)!
    const result = assembleModelContext({
      candidates: [
        { item: inspection.caseEvidence, reason: 'Active exception.', required: true },
        { item: agreement, reason: 'Current commitment.', required: true },
      ],
      knownCandidates: inspection.candidateEvidence,
      conflicts: [],
      tokenBudget: 2_000,
      versions: compileTestContext().bundle.skillVersions
        ? { program: 'program@1', contextBundle: 'bundle@1', skills: compileTestContext().bundle.skillVersions }
        : { program: 'program@1', contextBundle: 'bundle@1', skills: {} },
      modelFacingStaticContext: { program: 'program@1' },
    })
    expect(result.includedItems.map((item) => item.id)).toEqual(['ev-case-0881', 'ev-agreement-2026'])
    expect(result.envelope.omittedEvidence).toContainEqual(expect.objectContaining({
      evidenceId: 'ev-noise-0',
      reason: expect.stringContaining('outside the current exception'),
    }))
    expect(result.envelope.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports required evidence that cannot fit rather than silently truncating it', () => {
    const source = makeSource()
    const caseEvidence = source.inspectServiceException({ tenantId: 'ten_harborworks', caseId: 'case_0881' }).caseEvidence
    const result = assembleModelContext({
      candidates: [{ item: caseEvidence, reason: 'Active exception.', required: true }],
      knownCandidates: [],
      conflicts: [],
      tokenBudget: 100,
      versions: { program: 'program@1', contextBundle: 'bundle@1', skills: {} },
      modelFacingStaticContext: { program: 'program@1' },
    })
    expect(result.overflowedRequiredEvidenceIds).toEqual([caseEvidence.id])
    expect(result.envelope.tokenEstimate).toBeGreaterThan(result.envelope.tokenBudget)
  })

  it('counts full model-facing metadata and fails closed when omission inventory cannot fit', () => {
    const source = makeSource()
    const caseEvidence = source.inspectServiceException({ tenantId: 'ten_harborworks', caseId: 'case_0881' }).caseEvidence
    const knownCandidates = Array.from({ length: 10_000 }, (_, index) => ({
      evidenceId: `ev-noise-${index}`,
      reason: 'Archived history is outside the current decision window.',
    }))
    const result = assembleModelContext({
      candidates: [{ item: caseEvidence, reason: 'Active exception.', required: true }],
      knownCandidates,
      conflicts: [{ evidenceIds: ['ev-a', 'ev-b'], reason: 'Conflicting evidence.' }],
      tokenBudget: 900,
      versions: { program: 'program@1', contextBundle: 'bundle@1', skills: { inspect_service_exception: '1' } },
      modelFacingStaticContext: { allowedSkills: ['inspect_service_exception'], policyVersion: '1' },
    })
    expect(result.envelope.tokenEstimate).toBeGreaterThan(96)
    expect(result.omissionMetadataTruncated).toBe(true)
    expect(result.unreportedOmissionCount).toBeGreaterThan(9_000)
    expect(result.envelope.omittedEvidence.at(-1)).toEqual(expect.objectContaining({
      evidenceId: 'omission-residual',
      reason: expect.stringContaining(String(result.unreportedOmissionCount)),
    }))
  })
})
