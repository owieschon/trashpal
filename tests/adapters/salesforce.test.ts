import { describe, expect, test } from 'vitest'
import * as adapterExports from '../../packages/adapters/src/index.js'
import {
  RecordedSalesforcePageTransport,
  RecordedSalesforceSnapshotTransport,
  RecordedSalesforceTransportError,
  recordedSalesforceFieldMapping,
  salesforceSnapshotObjects,
  type RecordedSalesforcePage,
  type RecordedSalesforceRawRecord,
  type SalesforcePageTransport,
  type SalesforceMappingDescriptor,
  type SalesforceSnapshotObject,
} from '../../packages/adapters/src/index.js'
import {
  RecordedSalesforceContextSource,
  RecordedSalesforceSnapshotSchema,
  SourceMappingMetadataSchema,
} from '../../packages/context/src/index.js'

const observedAt = '2026-07-21T13:15:00-05:00'
const tenantId = 'ten_harborworks'

const caseRecords: RecordedSalesforceRawRecord[] = [
  {
    Id: 'sf_case_0881', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_case-0881', LastModifiedDate: observedAt,
    External_Case_Id__c: 'case_0881', Service_Site__c: 'site_greenleaf_c184', Subject: 'Collection not completed', Description: 'Overflow risk before dinner service.',
  },
  {
    Id: 'sf_case_other', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_case-other', LastModifiedDate: observedAt,
    External_Case_Id__c: 'case_other', Service_Site__c: 'site_other', Subject: 'Other case', Description: 'Unrelated.',
  },
]

const objectRecords: Record<SalesforceSnapshotObject, RecordedSalesforceRawRecord[]> = {
  cases: caseRecords,
  serviceAgreements: [{
    Id: 'sf_agreement_greenleaf_2026', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_agreement-2026', LastModifiedDate: observedAt,
    Service_Site__c: 'site_greenleaf_c184', Active__c: true, Stream__c: 'ORGANICS',
    Recovery_Deadline__c: '2026-07-21T17:30:00-05:00', Valid_Through__c: '2026-07-22T13:15:00-05:00',
  }],
  caseComments: [{
    Id: 'sf_comment_0881', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_access-1317', LastModifiedDate: observedAt,
    ParentId: 'sf_case_0881', Access_Status__c: 'confirmed_clear', Valid_From__c: '2026-07-21T14:00:00-05:00',
    Valid_Until__c: '2026-07-21T16:00:00-05:00', CommentBody: 'Gate is clear.',
  }],
  fieldAttempts: [{
    Id: 'attempt_0718', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_attempt-0718', LastModifiedDate: observedAt,
    External_Case_Id__c: 'case_0881', Status__c: 'unable_to_complete', Reason__c: 'gate_blocked', Observed_At__c: '2026-07-21T07:18:00-05:00',
  }],
  caseHistory: [{
    Id: 'history_1', Tenant_Key__c: tenantId, Evidence_Key__c: 'ev_history-1', LastModifiedDate: observedAt,
    ParentId: 'sf_case_0881', Summary__c: 'Prior unrelated note.',
  }],
}

function page(object: SalesforceSnapshotObject, records: RecordedSalesforceRawRecord[], input: Partial<RecordedSalesforcePage> = {}): RecordedSalesforcePage {
  return {
    object,
    records,
    nextCursor: null,
    done: true,
    totalSize: records.length,
    truncated: false,
    capturedAt: '2026-07-21T13:17:00-05:00',
    ...input,
  }
}

function pages(): Record<SalesforceSnapshotObject, RecordedSalesforcePage[]> {
  return {
    cases: [
      page('cases', [caseRecords[0]!], { nextCursor: '1', done: false, totalSize: 2 }),
      page('cases', [caseRecords[1]!], { totalSize: 2 }),
    ],
    serviceAgreements: [page('serviceAgreements', objectRecords.serviceAgreements)],
    caseComments: [page('caseComments', objectRecords.caseComments)],
    fieldAttempts: [page('fieldAttempts', objectRecords.fieldAttempts)],
    caseHistory: [page('caseHistory', objectRecords.caseHistory)],
  }
}

function mapping(fields: SalesforceMappingDescriptor['fields'] = recordedSalesforceFieldMapping): SalesforceMappingDescriptor {
  return {
    id: 'salesforce-service-context', tenantId, version: '1.0.0', status: 'confirmed' as const,
    verifiedAt: '2026-07-21T13:00:00-05:00', validUntil: '2026-07-22T13:00:00-05:00',
    requiredObjects: salesforceSnapshotObjects, fields,
  }
}

function transport(pageTransport: SalesforcePageTransport = new RecordedSalesforcePageTransport(pages()), fields?: Record<string, string>) {
  return new RecordedSalesforceSnapshotTransport({
    pages: pageTransport,
    mapping: mapping(fields as SalesforceMappingDescriptor['fields'] | undefined),
    pageSize: 100,
    maxPagesPerObject: 4,
  })
}

describe('recorded Salesforce snapshot transport', () => {
  test('returns complete page/count/field metadata for strict context normalization', async () => {
    expect('RecordedSalesforceContextSource' in adapterExports).toBe(false)
    const loaded = await transport().loadSnapshot({ tenantId })
    expect(loaded.mapping).toMatchObject({
      tenantId,
      coverage: { requiredObjects: salesforceSnapshotObjects, observedObjects: salesforceSnapshotObjects, complete: true, truncated: false },
      fields: recordedSalesforceFieldMapping,
    })
    expect(loaded.snapshot.metadata.objects).toEqual([
      { name: 'cases', complete: true, truncated: false, recordCount: 2 },
      { name: 'serviceAgreements', complete: true, truncated: false, recordCount: 1 },
      { name: 'caseComments', complete: true, truncated: false, recordCount: 1 },
      { name: 'fieldAttempts', complete: true, truncated: false, recordCount: 1 },
      { name: 'caseHistory', complete: true, truncated: false, recordCount: 1 },
    ])

    const normalizedMapping = SourceMappingMetadataSchema.parse(loaded.mapping)
    const normalizedSnapshot = RecordedSalesforceSnapshotSchema.parse(loaded.snapshot)
    const context = new RecordedSalesforceContextSource({ mapping: normalizedMapping, snapshot: normalizedSnapshot, now: '2026-07-21T13:20:00-05:00' })
    expect(context.inspectServiceException({ tenantId, caseId: 'case_0881' }).caseEvidence.sourceId).toBe('sf_case_0881')
  })

  test('fails closed on tenant leakage before context normalization', async () => {
    const leaked = pages()
    leaked.caseComments[0] = page('caseComments', [{ ...objectRecords.caseComments[0]!, Tenant_Key__c: 'ten_other' }])
    await expect(new RecordedSalesforceSnapshotTransport({ pages: new RecordedSalesforcePageTransport(leaked), mapping: mapping() }).loadSnapshot({ tenantId }))
      .rejects.toMatchObject({ code: 'TENANT_SCOPE_VIOLATION', retryable: false })
  })

  test('rejects a duplicate source record across pages', async () => {
    const duplicate = pages()
    duplicate.cases[1] = page('cases', [caseRecords[0]!], { totalSize: 2 })
    await expect(transport(new RecordedSalesforcePageTransport(duplicate)).loadSnapshot({ tenantId }))
      .rejects.toMatchObject({ code: 'MALFORMED_SOURCE_PAGE', retryable: false })
  })

  test('distinguishes source unavailability, cursor cycles, truncation, and count mismatch', async () => {
    const unavailable = transport(new RecordedSalesforcePageTransport(pages(), { failAt: { object: 'cases', page: 1 } }))
    await expect(unavailable.loadSnapshot({ tenantId })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: true })

    const cycle: SalesforcePageTransport = {
      async readPage({ object }) { return page(object, [], { done: false, nextCursor: 'loop', totalSize: 0 }) },
    }
    await expect(transport(cycle).loadSnapshot({ tenantId })).rejects.toMatchObject({ code: 'PAGINATION_CYCLE', retryable: false })

    const truncatedPages = pages()
    truncatedPages.cases[0] = page('cases', [caseRecords[0]!], { truncated: true })
    await expect(transport(new RecordedSalesforcePageTransport(truncatedPages)).loadSnapshot({ tenantId }))
      .rejects.toMatchObject({ code: 'PAGINATION_TRUNCATED', retryable: false })

    const mismatchPages = pages()
    mismatchPages.caseComments[0] = page('caseComments', objectRecords.caseComments, { totalSize: 2 })
    await expect(transport(new RecordedSalesforcePageTransport(mismatchPages)).loadSnapshot({ tenantId }))
      .rejects.toMatchObject({ code: 'SOURCE_COUNT_MISMATCH', retryable: false })
  })

  test.each([
    ['missing', Object.fromEntries(Object.entries(recordedSalesforceFieldMapping).slice(1))],
    ['mismatched', { ...recordedSalesforceFieldMapping, caseId: 'Case.Naive_Guess__c' }],
    ['nonsense', { ...recordedSalesforceFieldMapping, inventedSemantic: 'Case.Invented__c' }],
  ])('rejects a %s fixed-schema mapping before reading Salesforce', async (_label, fields) => {
    let reads = 0
    const unread: SalesforcePageTransport = {
      async readPage() {
        reads += 1
        throw new Error('must not be called')
      },
    }
    await expect(transport(unread, fields).loadSnapshot({ tenantId }))
      .rejects.toBeInstanceOf(RecordedSalesforceTransportError)
    await expect(transport(unread, fields).loadSnapshot({ tenantId }))
      .rejects.toMatchObject({ code: 'FIELD_MAPPING_INCOMPLETE', retryable: false })
    expect(reads).toBe(0)
  })
})
