export type EvidenceStatus = 'confirmed' | 'observed' | 'pending'

export interface OperatorEvidence {
  readonly id: string
  readonly label: string
  readonly status: EvidenceStatus
  readonly detail: string
}

export interface OperatorProposal {
  readonly id: string
  readonly digest: string
  readonly validUntil: string
  readonly workOrder: {
    readonly vehicleId: string
    readonly serviceStart: string
    readonly serviceEnd: string
  }
  readonly claims: readonly {
    readonly text: string
    readonly evidenceIds: readonly string[]
  }[]
}

export interface OperatorOperation {
  readonly id: string
  readonly state: string
  readonly revision: number
  readonly updatedAt: string
  readonly providerAssignmentId?: string
}

export interface OperatorReceipt {
  readonly operationId: string
  readonly operationRevision: number
  readonly state: string
  readonly evidenceCount: number
  readonly digest: string
  readonly recordedAt: string
  readonly binding: {
    readonly proposalDigest: string
    readonly approvalDigest: string
    readonly routeQuoteHash: string
    readonly workOrder: {
      readonly vehicleId: string
      readonly serviceStart: string
      readonly serviceEnd: string
    }
    readonly evidenceIds: readonly string[]
  }
}

export interface CaseOperatorView {
  readonly case: {
    readonly id: string
    readonly title: string
    readonly serviceType: string
    readonly priority: string
    readonly serviceWindowEndsAt: string
    /** Server-owned IANA zone for every operator-facing case timestamp. */
    readonly timeZone: string
  }
  readonly summary: {
    readonly phase: 'source_records_available' | 'recovery_prepared' | 'historical_decision'
    readonly whatHappened: string
    readonly whatPalChecked: readonly string[]
    readonly whatIsUnknown: readonly string[]
  }
  readonly evidence: readonly OperatorEvidence[]
  readonly activity: readonly {
    readonly id: string
    readonly label: string
    readonly detail: string
    readonly status: 'complete' | 'current'
    readonly occurredAt?: string
  }[]
  readonly palRun?: {
    readonly outcome: 'prepare_recovery' | 'hold_for_confirmation' | 'escalate'
    readonly stopCode: 'proposal_validated' | 'human_confirmation_required' | 'safe_recovery_not_prepared'
    readonly skillCount: number
    readonly includedEvidence: readonly string[]
    readonly omittedEvidence: readonly string[]
    readonly conflicts: readonly string[]
    readonly reasoner: 'deterministic_local'
  }
  readonly proposal?: OperatorProposal
  readonly approval?: {
    readonly digest: string
    readonly proposalDigest: string
    readonly validUntil: string
  }
  readonly operation?: OperatorOperation
  readonly receiptAvailable: boolean
  readonly nextAction: {
    readonly kind: string
    readonly label: string
    readonly requiresApproval: boolean
  }
}

export interface OperatorQueueCase {
  readonly id: string
  readonly title: string
  readonly priority: string
}

export interface LocalOperatorSession {
  readonly mode: 'local_demo'
  readonly actor: {
    readonly label: string
    readonly capabilities: readonly string[]
  }
}

export interface CaseResponse {
  readonly case: CaseOperatorView
}

export interface PrepareResponse extends CaseResponse {
  readonly preparation: {
    readonly proposalId: string
    readonly outcome: 'prepare_recovery'
  }
}

export interface ApprovalResponse extends CaseResponse {
  readonly approval: {
    readonly digest: string
    readonly proposalDigest: string
    readonly validUntil: string
  }
  readonly operation: OperatorOperation
  readonly replayed: boolean
}

export interface OperationResponse extends CaseResponse {
  readonly operation: OperatorOperation
  readonly receipt?: OperatorReceipt
}

export interface ReceiptResponse extends CaseResponse {
  readonly receipt: OperatorReceipt
}

export type HelpTopic = 'overview' | 'prepare' | 'approve' | 'dispatch' | 'reconcile' | 'receipt' | 'developer-reference'

export interface HelpArticle {
  readonly topic: HelpTopic
  readonly title: string
  /** Canonical Markdown served from docs/help; the browser never owns a second Help corpus. */
  readonly markdown: string
}

export const GREENLEAF_CASE_ID = 'case_greenleaf-operator'

export class OperatorApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'OperatorApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
    const detail = typeof body?.message === 'string'
      ? body.message
      : typeof body?.error === 'string'
        ? body.error.replaceAll('_', ' ')
        : `Request failed (${response.status})`
    throw new OperatorApiError(detail, response.status)
  }
  return await response.json() as T
}

/**
 * The API adapter is intentionally the only browser-to-server seam. Sessions
 * are HttpOnly cookies issued by the operator facade; this client never holds
 * a bearer or worker capability token.
 */
export const operatorApi = {
  async startLocalSession(): Promise<LocalOperatorSession> {
    const response = await request<{ session: LocalOperatorSession }>('/v1/operator/session', { method: 'POST' })
    return response.session
  },
  getCase(caseId = GREENLEAF_CASE_ID): Promise<CaseResponse> {
    return request<CaseResponse>(`/v1/operator/cases/${encodeURIComponent(caseId)}`)
  },
  async listCases(): Promise<readonly OperatorQueueCase[]> {
    const response = await request<{ cases?: unknown }>('/v1/operator/cases')
    if (!Array.isArray(response.cases) || !response.cases.every(isOperatorQueueCase)) {
      throw new OperatorApiError('The local operator queue returned an invalid case.', 502)
    }
    return response.cases
  },
  prepare(caseId = GREENLEAF_CASE_ID): Promise<PrepareResponse> {
    return request<PrepareResponse>(`/v1/operator/cases/${encodeURIComponent(caseId)}/prepare`, { method: 'POST' })
  },
  approve(proposalId: string): Promise<ApprovalResponse> {
    return request<ApprovalResponse>(`/v1/operator/proposals/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' })
  },
  reserve(approvalDigest: string): Promise<OperationResponse> {
    return request<OperationResponse>(`/v1/operator/approvals/${encodeURIComponent(approvalDigest)}/reserve`, { method: 'POST' })
  },
  dispatch(operationId: string): Promise<OperationResponse> {
    return request<OperationResponse>(`/v1/operator/operations/${encodeURIComponent(operationId)}/dispatch`, { method: 'POST' })
  },
  reconcile(operationId: string): Promise<OperationResponse> {
    return request<OperationResponse>(`/v1/operator/operations/${encodeURIComponent(operationId)}/reconcile`, { method: 'POST' })
  },
  getReceipt(operationId: string): Promise<ReceiptResponse> {
    return request<ReceiptResponse>(`/v1/operator/operations/${encodeURIComponent(operationId)}/receipt`)
  },
  async contextualHelp(topic: HelpTopic): Promise<HelpArticle> {
    const response = await request<{ article?: unknown }>(`/v1/operator/help?topic=${encodeURIComponent(topic)}`)
    if (!isHelpArticle(response.article) || response.article.topic !== topic) {
      throw new OperatorApiError('The Help Center returned an invalid article.', 502)
    }
    return response.article
  },
}

function isOperatorQueueCase(value: unknown): value is OperatorQueueCase {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.priority === 'string'
}

function isHelpArticle(value: unknown): value is HelpArticle {
  if (!value || typeof value !== 'object') return false
  const article = value as Record<string, unknown>
  return isHelpTopic(article.topic) && typeof article.title === 'string' && typeof article.markdown === 'string'
}

function isHelpTopic(value: unknown): value is HelpTopic {
  return value === 'overview' || value === 'prepare' || value === 'approve' || value === 'dispatch' || value === 'reconcile' || value === 'receipt' || value === 'developer-reference'
}

export type OperatorAction = 'prepare' | 'approve' | 'reserve' | 'dispatch' | 'reconcile' | 'view_receipt'

/** The API owns lifecycle progression. The client never infers a next state. */
export function nextOperatorAction(view: CaseOperatorView): OperatorAction | null {
  switch (view.nextAction.kind) {
    case 'prepare':
    case 'approve':
    case 'reserve':
    case 'dispatch':
    case 'reconcile':
    case 'view_receipt':
      return view.nextAction.kind
    default:
      return null
  }
}
