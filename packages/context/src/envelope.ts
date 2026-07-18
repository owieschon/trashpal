import {
  EvidenceItemSchema,
  ModelContextEnvelopeSchema,
  contentDigest,
} from '@trashpal/contracts'
import { z } from 'zod'

type EvidenceItem = z.infer<typeof EvidenceItemSchema>
type ModelContextEnvelope = z.infer<typeof ModelContextEnvelopeSchema>

const MAX_CANDIDATE_DESCRIPTORS = 256
const DIGEST_PLACEHOLDER = '0'.repeat(64)

export interface ContextCandidate {
  item: EvidenceItem
  reason: string
  required: boolean
}

export interface KnownContextCandidate {
  evidenceId: string
  reason: string
}

export interface ContextConflict {
  evidenceIds: string[]
  reason: string
}

export interface ContextAssembly {
  envelope: ModelContextEnvelope
  includedItems: EvidenceItem[]
  modelItems: ModelEvidenceItem[]
  missingRequiredEvidenceIds: string[]
  overflowedRequiredEvidenceIds: string[]
  omissionMetadataTruncated: boolean
  unreportedOmissionCount: number
}

export interface ModelEvidenceItem {
  id: EvidenceItem['id']
  authority: EvidenceItem['authority']
  freshness: EvidenceItem['freshness']
  content: EvidenceItem['content']
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function estimateModelPayload(input: {
  staticContext: unknown
  includedItems: ModelEvidenceItem[]
  includedEvidence: ModelContextEnvelope['includedEvidence']
  omittedEvidence: ModelContextEnvelope['omittedEvidence']
  conflicts: ModelContextEnvelope['conflicts']
  tokenBudget: number
  versions: ModelContextEnvelope['versions']
}): number {
  let estimate = 0
  for (let pass = 0; pass < 4; pass += 1) {
    const next = estimateTokens({
      staticContext: input.staticContext,
      evidence: input.includedItems,
      envelope: {
        includedEvidence: input.includedEvidence,
        omittedEvidence: input.omittedEvidence,
        conflicts: input.conflicts,
        tokenEstimate: estimate,
        tokenBudget: input.tokenBudget,
        versions: input.versions,
        digest: DIGEST_PLACEHOLDER,
      },
    })
    if (next === estimate) break
    estimate = next
  }
  return estimate
}

export function assembleModelContext(input: {
  candidates: ContextCandidate[]
  knownCandidates: KnownContextCandidate[]
  conflicts: ContextConflict[]
  tokenBudget: number
  versions: ModelContextEnvelope['versions']
  modelFacingStaticContext: unknown
}): ContextAssembly {
  const unique = new Map<string, ContextCandidate>()
  for (const candidate of input.candidates) {
    const item = EvidenceItemSchema.parse(candidate.item)
    unique.set(item.id, { ...candidate, item })
  }
  const ordered = [...unique.values()].sort((left, right) => Number(right.required) - Number(left.required))
  const included: ContextCandidate[] = []
  const pendingOmissions: ModelContextEnvelope['omittedEvidence'] = []
  const overflowedRequiredEvidenceIds: string[] = []

  const metadataFor = (candidate: ContextCandidate) => ({
    evidenceId: candidate.item.id,
    reason: candidate.reason,
    authority: candidate.item.authority,
    freshness: candidate.item.freshness,
  })
  const modelItemFor = (candidate: ContextCandidate): ModelEvidenceItem => ({
    id: candidate.item.id,
    authority: candidate.item.authority,
    freshness: candidate.item.freshness,
    content: candidate.item.content,
  })

  for (const candidate of ordered) {
    const trial = [...included, candidate]
    const trialTokens = estimateModelPayload({
      staticContext: input.modelFacingStaticContext,
      includedItems: trial.map(modelItemFor),
      includedEvidence: trial.map(metadataFor),
      omittedEvidence: pendingOmissions,
      conflicts: input.conflicts,
      tokenBudget: input.tokenBudget,
      versions: input.versions,
    })
    if (trialTokens <= input.tokenBudget || candidate.required) {
      included.push(candidate)
      if (candidate.required && trialTokens > input.tokenBudget) overflowedRequiredEvidenceIds.push(candidate.item.id)
      continue
    }
    pendingOmissions.push({
      evidenceId: candidate.item.id,
      reason: 'Optional evidence was omitted to preserve the complete model-context budget.',
      authority: candidate.item.authority,
      freshness: candidate.item.freshness,
    })
  }

  const loadedIds = new Set<string>(unique.keys())
  const uniqueKnown = new Map<string, KnownContextCandidate>()
  for (const candidate of input.knownCandidates.slice(0, MAX_CANDIDATE_DESCRIPTORS)) {
    if (!loadedIds.has(candidate.evidenceId)) uniqueKnown.set(candidate.evidenceId, candidate)
  }
  const descriptorOverflow = Math.max(0, input.knownCandidates.length - MAX_CANDIDATE_DESCRIPTORS)
  for (const candidate of uniqueKnown.values()) {
    pendingOmissions.push({ evidenceId: candidate.evidenceId, reason: candidate.reason })
  }

  const includedEvidence = included.map(metadataFor)
  const omittedEvidence: ModelContextEnvelope['omittedEvidence'] = []
  let unreportedOmissionCount = descriptorOverflow
  for (let index = 0; index < pendingOmissions.length; index += 1) {
    const omission = pendingOmissions[index]!
    const trial = [...omittedEvidence, omission]
    const trialTokens = estimateModelPayload({
      staticContext: input.modelFacingStaticContext,
      includedItems: included.map(modelItemFor),
      includedEvidence,
      omittedEvidence: trial,
      conflicts: input.conflicts,
      tokenBudget: input.tokenBudget,
      versions: input.versions,
    })
    if (trialTokens <= input.tokenBudget) {
      omittedEvidence.push(omission)
      continue
    }
    unreportedOmissionCount += pendingOmissions.length - index
    break
  }

  const omissionMetadataTruncated = unreportedOmissionCount > 0
  if (omissionMetadataTruncated) {
    const makeResidual = () => ({
      evidenceId: 'omission-residual',
      reason: `${unreportedOmissionCount} additional omission records did not fit; this context is incomplete and must fail closed.`,
    })
    while (omittedEvidence.length > 0) {
      const trialTokens = estimateModelPayload({
        staticContext: input.modelFacingStaticContext,
        includedItems: included.map(modelItemFor),
        includedEvidence,
        omittedEvidence: [...omittedEvidence, makeResidual()],
        conflicts: input.conflicts,
        tokenBudget: input.tokenBudget,
        versions: input.versions,
      })
      if (trialTokens <= input.tokenBudget) break
      omittedEvidence.pop()
      unreportedOmissionCount += 1
    }
    omittedEvidence.push(makeResidual())
  }

  const tokenEstimate = estimateModelPayload({
    staticContext: input.modelFacingStaticContext,
    includedItems: included.map(modelItemFor),
    includedEvidence,
    omittedEvidence,
    conflicts: input.conflicts,
    tokenBudget: input.tokenBudget,
    versions: input.versions,
  })
  const missingRequiredEvidenceIds = ordered
    .filter((candidate) => candidate.required && candidate.item.freshness !== 'fresh')
    .map((candidate) => candidate.item.id)
  const unsigned = {
    includedEvidence,
    omittedEvidence,
    conflicts: input.conflicts,
    tokenEstimate,
    tokenBudget: input.tokenBudget,
    versions: input.versions,
  }
  const envelope = ModelContextEnvelopeSchema.parse({ ...unsigned, digest: contentDigest(unsigned) })
  return {
    envelope,
    includedItems: included.map(({ item }) => item),
    modelItems: included.map(modelItemFor),
    missingRequiredEvidenceIds,
    overflowedRequiredEvidenceIds,
    omissionMetadataTruncated,
    unreportedOmissionCount,
  }
}
