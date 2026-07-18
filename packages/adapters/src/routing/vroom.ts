import { createHash } from 'node:crypto'
import { vehicleEligibility, validateRouteRequest } from './eligibility.js'
import type {
  ConstraintFailure,
  RecoveryRouteRequest,
  RecoveryRouteResult,
  RecoveryVehicle,
  ServiceWindow,
  VroomProblem,
  VroomResponse,
  VroomStep,
  VroomTransport,
} from './contracts.js'

const RECOVERY_JOB_ID = 900_001

type CommittedJobBinding = Readonly<{
  numericJobId: number
  numericVehicleId: number
  vehicleId: string
  workId: string
  serviceSeconds: number
}>

type EncodedProblem = Readonly<{
  problem: VroomProblem
  vehicleByNumericId: ReadonlyMap<number, RecoveryVehicle>
  committedJobs: ReadonlyMap<number, CommittedJobBinding>
  rejectedVehicles: readonly ConstraintFailure[]
}>

type UnavailableResult = Extract<RecoveryRouteResult, { status: 'unavailable' }>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function epochSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1_000)
}

function vroomWindows(windows: readonly ServiceWindow[]): readonly (readonly [number, number])[] {
  return windows.map((window) => [epochSeconds(window.startAt), epochSeconds(window.endAt)] as const)
}

export function encodeVroomProblem(request: RecoveryRouteRequest): EncodedProblem {
  if (validateRouteRequest(request).length > 0) throw new Error('cannot encode an invalid recovery route request')
  const rejectedVehicles: ConstraintFailure[] = []
  const eligible: RecoveryVehicle[] = []
  for (const vehicle of request.vehicles) {
    const failures = vehicleEligibility(request, vehicle)
    if (failures.length > 0) rejectedVehicles.push(...failures)
    else eligible.push(vehicle)
  }

  const vehicleByNumericId = new Map<number, RecoveryVehicle>()
  const committedJobs = new Map<number, CommittedJobBinding>()
  const pinSkillBase = Math.max(
    request.streamCapability,
    ...request.vehicles.flatMap((vehicle) => [
      ...vehicle.capabilities,
      ...vehicle.committedWork.flatMap((work) => work.requiredCapabilities),
    ]),
  ) + 1
  let committedJobId = 10_000
  let breakId = 20_000
  const jobs: VroomProblem['jobs'][number][] = []
  const vehicles: VroomProblem['vehicles'][number][] = []

  eligible.forEach((vehicle, index) => {
    const numericVehicleId = 100 + index
    const vehiclePinSkill = pinSkillBase + index
    vehicleByNumericId.set(numericVehicleId, vehicle)
    vehicles.push({
      id: numericVehicleId,
      description: vehicle.id,
      profile: 'car',
      start_index: vehicle.startIndex,
      end_index: vehicle.endIndex,
      capacity: [vehicle.capacityKg],
      skills: [...vehicle.capabilities, vehiclePinSkill],
      time_window: [Math.max(epochSeconds(vehicle.shift.startAt), epochSeconds(request.requestedAt)), epochSeconds(vehicle.shift.endAt)],
      breaks: vehicle.breaks.map((item) => ({
        id: breakId++,
        description: item.id,
        service: item.serviceSeconds,
        time_windows: vroomWindows(item.timeWindows),
      })),
    })
    for (const work of vehicle.committedWork) {
      const numericJobId = committedJobId++
      committedJobs.set(numericJobId, {
        numericJobId,
        numericVehicleId,
        vehicleId: vehicle.id,
        workId: work.id,
        serviceSeconds: work.serviceSeconds,
      })
      jobs.push({
        id: numericJobId,
        description: `${vehicle.id}:${work.id}`,
        location_index: work.locationIndex,
        service: work.serviceSeconds,
        pickup: [work.pickupKg],
        skills: [...work.requiredCapabilities, vehiclePinSkill],
        time_windows: vroomWindows(work.timeWindows),
      })
    }
  })

  jobs.push({
    id: RECOVERY_JOB_ID,
    description: `recovery:${request.caseId}`,
    location_index: request.recoveryLocationIndex,
    service: request.serviceSeconds,
    pickup: [request.pickupKg],
    skills: [request.streamCapability],
    time_windows: vroomWindows([request.confirmedAccessWindow]),
  })

  return {
    problem: { jobs, vehicles, matrices: { car: { durations: request.matrix.durationsSeconds } } },
    vehicleByNumericId,
    committedJobs,
    rejectedVehicles,
  }
}

function wholeNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseVroomResponse(value: unknown): VroomResponse | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!wholeNonnegative(record.code) || !Array.isArray(record.unassigned) || !Array.isArray(record.routes)) return null
  for (const routeValue of record.routes) {
    if (routeValue === null || typeof routeValue !== 'object') return null
    const route = routeValue as Record<string, unknown>
    if (!wholeNonnegative(route.vehicle) || !wholeNonnegative(route.duration) || !wholeNonnegative(route.service) || !Array.isArray(route.steps)) return null
    for (const stepValue of route.steps) {
      if (stepValue === null || typeof stepValue !== 'object') return null
      const step = stepValue as Record<string, unknown>
      if (!['start', 'job', 'break', 'end'].includes(String(step.type))
        || !wholeNonnegative(step.arrival)
        || !wholeNonnegative(step.waiting_time)
        || !wholeNonnegative(step.service)) return null
      if (step.type === 'job' && !wholeNonnegative(step.id)) return null
      if (step.load !== undefined && (!Array.isArray(step.load) || step.load.some((item) => !wholeNonnegative(item)))) return null
    }
  }
  for (const itemValue of record.unassigned) {
    if (itemValue === null || typeof itemValue !== 'object') return null
    const item = itemValue as Record<string, unknown>
    if (!wholeNonnegative(item.id) || typeof item.type !== 'string') return null
  }
  return value as VroomResponse
}

type JobOccurrence = Readonly<{ numericVehicleId: number; stepIndex: number; steps: readonly VroomStep[] }>

function jobOccurrences(response: VroomResponse): Map<number, JobOccurrence[]> {
  const occurrences = new Map<number, JobOccurrence[]>()
  for (const route of response.routes) {
    route.steps.forEach((step, stepIndex) => {
      if (step.type !== 'job' || step.id === undefined) return
      const entries = occurrences.get(step.id) ?? []
      entries.push({ numericVehicleId: route.vehicle, stepIndex, steps: route.steps })
      occurrences.set(step.id, entries)
    })
  }
  return occurrences
}

function protocolFailure(code: ConstraintFailure['code'], message: string, vehicleId?: string): ConstraintFailure {
  return { layer: 'protocol', code, message, ...(vehicleId ? { vehicleId } : {}) }
}

function validateSolverProof(response: VroomResponse, encoded: EncodedProblem, includesRecovery: boolean): ConstraintFailure | null {
  const routeVehicles = new Set<number>()
  for (const route of response.routes) {
    if (!encoded.vehicleByNumericId.has(route.vehicle) || routeVehicles.has(route.vehicle)) {
      return protocolFailure('malformed_solver_response', 'VROOM returned an unknown or duplicated vehicle route')
    }
    routeVehicles.add(route.vehicle)
  }

  const allowedJobs = new Set(encoded.committedJobs.keys())
  if (includesRecovery) allowedJobs.add(RECOVERY_JOB_ID)
  for (const item of response.unassigned) {
    if (!allowedJobs.has(item.id)) return protocolFailure('malformed_solver_response', 'VROOM returned an unknown unassigned job')
  }
  const occurrences = jobOccurrences(response)
  for (const numericJobId of occurrences.keys()) {
    if (!allowedJobs.has(numericJobId)) return protocolFailure('malformed_solver_response', 'VROOM returned an unknown job step')
  }

  for (const binding of encoded.committedJobs.values()) {
    if (response.unassigned.some((item) => item.id === binding.numericJobId)) {
      return { layer: 'vroom_solver', code: 'committed_work_unassigned', vehicleId: binding.vehicleId, message: `VROOM could not preserve committed work ${binding.workId}` }
    }
    const matches = occurrences.get(binding.numericJobId) ?? []
    if (matches.length === 0) return protocolFailure('committed_work_missing', `VROOM omitted committed work ${binding.workId}`, binding.vehicleId)
    if (matches.length > 1) return protocolFailure('committed_work_duplicated', `VROOM duplicated committed work ${binding.workId}`, binding.vehicleId)
    if (matches[0]?.numericVehicleId !== binding.numericVehicleId) return protocolFailure('committed_work_moved', `VROOM moved committed work ${binding.workId} to another vehicle`, binding.vehicleId)
    const committedStep = matches[0]?.steps[matches[0].stepIndex]
    if (committedStep?.service !== binding.serviceSeconds) return protocolFailure('malformed_solver_response', `VROOM changed committed work ${binding.workId}`, binding.vehicleId)
  }
  return null
}

function recoveryOccurrence(response: VroomResponse): JobOccurrence[] {
  return jobOccurrences(response).get(RECOVERY_JOB_ID) ?? []
}

function solverFailure(message: string): ConstraintFailure {
  return { layer: 'vroom_solver', code: 'no_solver_assignment', message }
}

function operationalSeconds(response: VroomResponse, numericVehicleId: number): number | null {
  const route = response.routes.find((candidate) => candidate.vehicle === numericVehicleId)
  return route ? route.duration + route.service : null
}

export class HttpVroomTransport implements VroomTransport {
  readonly #endpoint: URL

  constructor(endpoint = 'http://127.0.0.1:3000/') {
    this.#endpoint = new URL(endpoint)
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.#endpoint.hostname)) throw new Error('the core VROOM transport is local-only')
  }

  async solve(problem: VroomProblem, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(problem),
      signal,
    })
    if (!response.ok) throw new Error(`VROOM HTTP ${response.status}`)
    return response.json()
  }
}

export class VroomRecoveryRoutePlanner {
  readonly #transport: VroomTransport
  readonly #timeoutMs: number

  constructor(transport: VroomTransport, options: Readonly<{ timeoutMs?: number }> = {}) {
    this.#transport = transport
    this.#timeoutMs = options.timeoutMs ?? 5_000
  }

  async #solve(problem: VroomProblem): Promise<Readonly<{ ok: true; response: VroomResponse }> | Readonly<{ ok: false; result: UnavailableResult }>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    let raw: unknown
    try {
      raw = await this.#transport.solve(problem, controller.signal)
    } catch (error) {
      const timedOut = controller.signal.aborted
      return {
        ok: false,
        result: {
          status: 'unavailable',
          retryable: true,
          failure: {
            layer: 'transport',
            code: timedOut ? 'solver_timeout' : 'solver_unavailable',
            message: timedOut ? 'VROOM exceeded the local solver deadline' : `VROOM transport failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          },
        },
      }
    } finally {
      clearTimeout(timeout)
    }
    const response = parseVroomResponse(raw)
    if (!response || response.code !== 0) {
      return {
        ok: false,
        result: {
          status: 'unavailable',
          retryable: false,
          failure: { layer: 'protocol', code: 'malformed_solver_response', message: response?.error ?? 'VROOM returned an invalid response' },
        },
      }
    }
    return { ok: true, response }
  }

  async quoteRecovery(request: RecoveryRouteRequest): Promise<RecoveryRouteResult> {
    const requestFailures = validateRouteRequest(request)
    if (requestFailures.length > 0) return { status: 'infeasible', failures: requestFailures }

    const encoded = encodeVroomProblem(request)
    if (encoded.problem.vehicles.length === 0) return { status: 'infeasible', failures: encoded.rejectedVehicles }

    const fullSolve = await this.#solve(encoded.problem)
    if (!fullSolve.ok) return fullSolve.result
    const fullProofFailure = validateSolverProof(fullSolve.response, encoded, true)
    if (fullProofFailure) {
      if (fullProofFailure.layer === 'vroom_solver') return { status: 'infeasible', failures: [...encoded.rejectedVehicles, fullProofFailure] }
      return { status: 'unavailable', retryable: false, failure: fullProofFailure }
    }
    if (fullSolve.response.unassigned.some((item) => item.id === RECOVERY_JOB_ID)) {
      return { status: 'infeasible', failures: [...encoded.rejectedVehicles, solverFailure('VROOM left the recovery job unassigned')] }
    }
    const recoveryMatches = recoveryOccurrence(fullSolve.response)
    if (recoveryMatches.length !== 1) {
      return { status: 'unavailable', retryable: false, failure: protocolFailure('malformed_solver_response', 'VROOM must return the recovery job exactly once') }
    }
    const match = recoveryMatches[0]
    if (!match) return { status: 'unavailable', retryable: false, failure: protocolFailure('malformed_solver_response', 'VROOM recovery step was missing') }
    const vehicle = encoded.vehicleByNumericId.get(match.numericVehicleId)
    const recoveryStep = match.steps[match.stepIndex]
    if (!vehicle || !recoveryStep) return { status: 'unavailable', retryable: false, failure: protocolFailure('malformed_solver_response', 'VROOM returned an unknown vehicle or recovery step') }
    if (recoveryStep.service !== request.serviceSeconds || recoveryStep.load?.length !== 1 || !wholeNonnegative(recoveryStep.load[0]) || recoveryStep.load[0] > vehicle.capacityKg) {
      return { status: 'unavailable', retryable: false, failure: protocolFailure('malformed_solver_response', 'VROOM recovery service or capacity result does not match the request', vehicle.id) }
    }

    const serviceStartSeconds = recoveryStep.arrival + (recoveryStep.waiting_time ?? 0)
    const serviceEndSeconds = serviceStartSeconds + recoveryStep.service
    const serviceStartMs = serviceStartSeconds * 1_000
    const serviceEndMs = serviceEndSeconds * 1_000
    if (serviceStartMs < Date.parse(request.confirmedAccessWindow.startAt) || serviceEndMs > Date.parse(request.confirmedAccessWindow.endAt)) {
      return {
        status: 'infeasible',
        failures: [...encoded.rejectedVehicles, {
          layer: 'host_access_postcondition',
          code: 'service_outside_access_window',
          vehicleId: vehicle.id,
          message: 'the complete service interval does not fit inside confirmed access',
        }],
      }
    }

    const baselineProblem: VroomProblem = { ...encoded.problem, jobs: encoded.problem.jobs.filter((job) => job.id !== RECOVERY_JOB_ID) }
    const baselineSolve = await this.#solve(baselineProblem)
    if (!baselineSolve.ok) return baselineSolve.result
    const baselineProofFailure = validateSolverProof(baselineSolve.response, encoded, false)
    if (baselineProofFailure) {
      if (baselineProofFailure.layer === 'vroom_solver') return { status: 'infeasible', failures: [...encoded.rejectedVehicles, baselineProofFailure] }
      return { status: 'unavailable', retryable: false, failure: baselineProofFailure }
    }
    const fullOperationalSeconds = operationalSeconds(fullSolve.response, match.numericVehicleId)
    const baselineOperationalSeconds = vehicle.committedWork.length === 0
      ? 0
      : operationalSeconds(baselineSolve.response, match.numericVehicleId)
    if (fullOperationalSeconds === null || baselineOperationalSeconds === null || fullOperationalSeconds < baselineOperationalSeconds) {
      return { status: 'unavailable', retryable: false, failure: protocolFailure('malformed_solver_response', 'VROOM could not establish a valid committed-work route baseline', vehicle.id) }
    }

    const validUntil = new Date(Math.min(Date.parse(request.quoteValidUntil), Date.parse(request.confirmedAccessWindow.endAt))).toISOString()
    const unsignedQuote = {
      tenantId: request.tenantId,
      vehicleId: vehicle.id,
      serviceStart: new Date(serviceStartMs).toISOString(),
      serviceEnd: new Date(serviceEndMs).toISOString(),
      validUntil,
      remainingCapacityKg: vehicle.capacityKg - recoveryStep.load[0],
      incrementalMinutes: (fullOperationalSeconds - baselineOperationalSeconds) / 60,
    }
    const hash = digest(unsignedQuote)
    return {
      status: 'feasible',
      quote: { id: `quote_${hash.slice(0, 24)}`, ...unsignedQuote, hash },
      rejectedVehicles: encoded.rejectedVehicles,
    }
  }
}
