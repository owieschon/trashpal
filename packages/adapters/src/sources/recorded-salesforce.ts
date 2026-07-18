import { createHash } from 'node:crypto'

export const salesforceSnapshotObjects = ['cases', 'serviceAgreements', 'caseComments', 'fieldAttempts', 'caseHistory'] as const
export type SalesforceSnapshotObject = typeof salesforceSnapshotObjects[number]

export const recordedSalesforceFieldMapping = Object.freeze({
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
} as const)

export type RecordedSalesforceFieldMapping = typeof recordedSalesforceFieldMapping

export type RecordedSalesforceRawRecord = Readonly<Record<string, unknown> & {
  Id: string
  Tenant_Key__c: string
}>

export type RecordedSalesforcePage = Readonly<{
  object: SalesforceSnapshotObject
  records: readonly RecordedSalesforceRawRecord[]
  nextCursor: string | null
  done: boolean
  totalSize: number
  truncated: boolean
  capturedAt: string
}>

export interface SalesforcePageTransport {
  readPage(input: Readonly<{
    tenantId: string
    object: SalesforceSnapshotObject
    cursor: string | null
    limit: number
    signal?: AbortSignal
  }>): Promise<RecordedSalesforcePage>
}

export type SalesforceMappingDescriptor = Readonly<{
  id: string
  tenantId: string
  version: string
  status: 'confirmed' | 'unresolved'
  verifiedAt: string
  validUntil: string
  requiredObjects: typeof salesforceSnapshotObjects
  fields: RecordedSalesforceFieldMapping
}>

export type ContextCompatibleSalesforceSnapshot = Readonly<{
  metadata: Readonly<{
    snapshotId: string
    capturedAt: string
    objects: readonly Readonly<{
      name: SalesforceSnapshotObject
      complete: boolean
      truncated: boolean
      recordCount: number
    }>[]
  }>
  records: Readonly<Record<SalesforceSnapshotObject, readonly RecordedSalesforceRawRecord[]>>
}>

export type ContextCompatibleSourceMapping = Readonly<{
  id: string
  tenantId: string
  version: string
  status: 'confirmed' | 'unresolved'
  verifiedAt: string
  validUntil: string
  coverage: Readonly<{
    requiredObjects: readonly string[]
    observedObjects: readonly string[]
    complete: boolean
    truncated: boolean
  }>
  fields: Readonly<Record<string, string>>
}>

export type RecordedSalesforceSnapshotLoad = Readonly<{
  mapping: ContextCompatibleSourceMapping
  snapshot: ContextCompatibleSalesforceSnapshot
}>

export interface SalesforceSnapshotTransport {
  loadSnapshot(input: Readonly<{ tenantId: string; signal?: AbortSignal }>): Promise<RecordedSalesforceSnapshotLoad>
}

export class RecordedSalesforceTransportError extends Error {
  constructor(
    readonly code:
      | 'SOURCE_UNAVAILABLE'
      | 'TENANT_SCOPE_VIOLATION'
      | 'PAGINATION_CYCLE'
      | 'PAGINATION_TRUNCATED'
      | 'SOURCE_COUNT_MISMATCH'
      | 'MALFORMED_SOURCE_PAGE'
      | 'FIELD_MAPPING_INCOMPLETE',
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'RecordedSalesforceTransportError'
  }
}

function wholeNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hasCanonicalFieldMapping(value: unknown): value is RecordedSalesforceFieldMapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = value as Record<string, unknown>
  const expected = Object.entries(recordedSalesforceFieldMapping)
  return Object.keys(actual).length === expected.length
    && expected.every(([semantic, source]) => actual[semantic] === source)
}

export class RecordedSalesforcePageTransport implements SalesforcePageTransport {
  readonly #pages: Readonly<Record<SalesforceSnapshotObject, readonly RecordedSalesforcePage[]>>
  readonly #failAt: Readonly<{ object: SalesforceSnapshotObject; page: number }> | null

  constructor(
    pages: Readonly<Record<SalesforceSnapshotObject, readonly RecordedSalesforcePage[]>>,
    options: Readonly<{ failAt?: Readonly<{ object: SalesforceSnapshotObject; page: number }> }> = {},
  ) {
    this.#pages = structuredClone(pages)
    this.#failAt = options.failAt ?? null
  }

  async readPage(input: Readonly<{
    tenantId: string
    object: SalesforceSnapshotObject
    cursor: string | null
    limit: number
    signal?: AbortSignal
  }>): Promise<RecordedSalesforcePage> {
    input.signal?.throwIfAborted()
    const index = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10)
    if (!Number.isSafeInteger(index) || index < 0 || this.#failAt?.object === input.object && this.#failAt.page === index) {
      throw new Error('recorded Salesforce page is unavailable')
    }
    const page = this.#pages[input.object][index]
    if (!page || page.records.length > input.limit) throw new Error('recorded Salesforce page is unavailable')
    return structuredClone(page)
  }
}

export class RecordedSalesforceSnapshotTransport implements SalesforceSnapshotTransport {
  readonly #pages: SalesforcePageTransport
  readonly #mapping: SalesforceMappingDescriptor
  readonly #pageSize: number
  readonly #maxPagesPerObject: number

  constructor(input: Readonly<{
    pages: SalesforcePageTransport
    mapping: SalesforceMappingDescriptor
    pageSize?: number
    maxPagesPerObject?: number
  }>) {
    this.#pages = input.pages
    this.#mapping = structuredClone(input.mapping)
    this.#pageSize = input.pageSize ?? 100
    this.#maxPagesPerObject = input.maxPagesPerObject ?? 20
  }

  async loadSnapshot(input: Readonly<{ tenantId: string; signal?: AbortSignal }>): Promise<RecordedSalesforceSnapshotLoad> {
    if (input.tenantId !== this.#mapping.tenantId) {
      throw new RecordedSalesforceTransportError('TENANT_SCOPE_VIOLATION', false, 'mapping and requested tenant do not match')
    }
    if (!this.#mapping.id
      || !this.#mapping.version
      || !validTimestamp(this.#mapping.verifiedAt)
      || !validTimestamp(this.#mapping.validUntil)
      || Date.parse(this.#mapping.verifiedAt) >= Date.parse(this.#mapping.validUntil)) {
      throw new RecordedSalesforceTransportError('MALFORMED_SOURCE_PAGE', false, 'source mapping identity or timestamps are invalid')
    }
    if (this.#mapping.requiredObjects.length !== salesforceSnapshotObjects.length
      || this.#mapping.requiredObjects.some((object, index) => object !== salesforceSnapshotObjects[index])
      || !hasCanonicalFieldMapping(this.#mapping.fields)) {
      throw new RecordedSalesforceTransportError('FIELD_MAPPING_INCOMPLETE', false, 'source objects and fields must match the fixed recorded Salesforce schema exactly')
    }

    const records = Object.fromEntries(salesforceSnapshotObjects.map((object) => [object, []])) as unknown as Record<SalesforceSnapshotObject, RecordedSalesforceRawRecord[]>
    const metadata: Array<{ name: SalesforceSnapshotObject; complete: boolean; truncated: boolean; recordCount: number }> = []
    let capturedAtMs = 0

    for (const object of this.#mapping.requiredObjects) {
      const cursors = new Set<string>()
      const recordIds = new Set<string>()
      let cursor: string | null = null
      let declaredTotal: number | null = null
      let pagesRead = 0
      let complete = false
      do {
        if (pagesRead >= this.#maxPagesPerObject) {
          throw new RecordedSalesforceTransportError('PAGINATION_TRUNCATED', false, `${object} exceeded the declared page limit`)
        }
        const cursorKey = cursor ?? '<first>'
        if (cursors.has(cursorKey)) throw new RecordedSalesforceTransportError('PAGINATION_CYCLE', false, `${object} repeated cursor ${cursorKey}`)
        cursors.add(cursorKey)

        let page: RecordedSalesforcePage
        try {
          page = await this.#pages.readPage({ tenantId: input.tenantId, object, cursor, limit: this.#pageSize, ...(input.signal ? { signal: input.signal } : {}) })
        } catch (error) {
          throw new RecordedSalesforceTransportError('SOURCE_UNAVAILABLE', true, `${object} read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
        }
        pagesRead += 1
        if (page.truncated === true) {
          throw new RecordedSalesforceTransportError('PAGINATION_TRUNCATED', false, `${object} reports a truncated source result`)
        }
        if (page.object !== object
          || !Array.isArray(page.records)
          || !wholeNonnegative(page.totalSize)
          || !validTimestamp(page.capturedAt)
          || typeof page.done !== 'boolean'
          || typeof page.truncated !== 'boolean'
          || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0)
          || page.records.length > this.#pageSize
          || page.done === (page.nextCursor !== null)) {
          throw new RecordedSalesforceTransportError('MALFORMED_SOURCE_PAGE', false, `${object} returned inconsistent completeness, count, or cursor metadata`)
        }
        if (declaredTotal !== null && declaredTotal !== page.totalSize) {
          throw new RecordedSalesforceTransportError('SOURCE_COUNT_MISMATCH', false, `${object} changed totalSize during pagination`)
        }
        declaredTotal = page.totalSize
        capturedAtMs = Math.max(capturedAtMs, Date.parse(page.capturedAt))
        for (const record of page.records) {
          if (!record || typeof record !== 'object' || typeof record.Id !== 'string' || !record.Id) {
            throw new RecordedSalesforceTransportError('MALFORMED_SOURCE_PAGE', false, `${object} returned a record without a source ID`)
          }
          if (record.Tenant_Key__c !== input.tenantId) {
            throw new RecordedSalesforceTransportError('TENANT_SCOPE_VIOLATION', false, `${object} returned record ${record.Id} from another tenant`)
          }
          if (recordIds.has(record.Id)) {
            throw new RecordedSalesforceTransportError('MALFORMED_SOURCE_PAGE', false, `${object} returned duplicate source record ${record.Id}`)
          }
          recordIds.add(record.Id)
          records[object].push(structuredClone(record))
        }
        complete = page.done
        cursor = page.nextCursor
      } while (!complete)

      if (declaredTotal === null || records[object].length !== declaredTotal) {
        throw new RecordedSalesforceTransportError('SOURCE_COUNT_MISMATCH', false, `${object} returned ${records[object].length} of ${declaredTotal ?? 0} declared records`)
      }
      metadata.push({ name: object, complete: true, truncated: false, recordCount: records[object].length })
    }

    const observedObjects = metadata.map(({ name }) => name)
    const coverageComplete = this.#mapping.requiredObjects.every((object) => observedObjects.includes(object))
    const capturedAt = new Date(capturedAtMs).toISOString()
    const snapshot: ContextCompatibleSalesforceSnapshot = {
      metadata: {
        snapshotId: `sf_snapshot_${digest({ tenantId: input.tenantId, capturedAt, metadata, records }).slice(0, 24)}`,
        capturedAt,
        objects: metadata,
      },
      records,
    }
    const mapping: ContextCompatibleSourceMapping = {
      id: this.#mapping.id,
      tenantId: this.#mapping.tenantId,
      version: this.#mapping.version,
      status: this.#mapping.status,
      verifiedAt: this.#mapping.verifiedAt,
      validUntil: this.#mapping.validUntil,
      coverage: {
        requiredObjects: this.#mapping.requiredObjects,
        observedObjects,
        complete: coverageComplete,
        truncated: false,
      },
      fields: this.#mapping.fields,
    }
    return { mapping, snapshot }
  }
}
