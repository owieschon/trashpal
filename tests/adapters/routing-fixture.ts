import type { RecoveryRouteRequest, VroomProblem, VroomResponse, VroomTransport } from '../../packages/adapters/src/index.js'

const t = (clock: string) => `2026-07-21T${clock}-05:00`
const at = (clock: string) => Math.floor(Date.parse(t(clock)) / 1_000)

export function greenleafRequest(overrides: Partial<RecoveryRouteRequest> = {}): RecoveryRouteRequest {
  const durations = [
    [0, 300, 480, 1500, 240],
    [300, 0, 360, 1500, 300],
    [480, 360, 0, 1500, 240],
    [1500, 1500, 1860, 0, 2040],
    [240, 300, 240, 2040, 0],
  ] as const
  const committed = (id: string, capability: number) => [{
    id,
    locationIndex: 3,
    serviceSeconds: 300,
    pickupKg: 240,
    requiredCapabilities: [capability],
    timeWindows: [{ startAt: t('13:44:00'), endAt: t('13:45:00') }],
  }]
  const breakWindow = [{ startAt: t('15:30:00'), endAt: t('16:00:00') }]
  return {
    tenantId: 'ten_harborworks',
    caseId: 'case_0881',
    requestedAt: t('13:20:00'),
    quoteValidUntil: t('15:00:00'),
    streamCapability: 101,
    pickupKg: 240,
    serviceSeconds: 900,
    recoveryLocationIndex: 4,
    confirmedAccessWindow: { startAt: t('14:00:00'), endAt: t('16:00:00') },
    vehicles: [
      {
        tenantId: 'ten_harborworks', id: 'veh_v17', available: true, startIndex: 0, endIndex: 0,
        capacityKg: 1140, capabilities: [1], shift: { startAt: t('13:00:00'), endAt: t('17:00:00') },
        breaks: [{ id: 'break_v17', serviceSeconds: 900, timeWindows: breakWindow }], committedWork: committed('committed_v17', 1),
      },
      {
        tenantId: 'ten_harborworks', id: 'veh_v83', available: true, startIndex: 1, endIndex: 1,
        capacityKg: 390, capabilities: [101], shift: { startAt: t('13:00:00'), endAt: t('17:00:00') },
        breaks: [{ id: 'break_v83', serviceSeconds: 900, timeWindows: breakWindow }], committedWork: committed('committed_v83', 101),
      },
      {
        tenantId: 'ten_harborworks', id: 'veh_v42', available: true, startIndex: 2, endIndex: 2,
        capacityKg: 670, capabilities: [101], shift: { startAt: t('13:00:00'), endAt: t('17:00:00') },
        breaks: [{ id: 'break_v42', serviceSeconds: 900, timeWindows: breakWindow }], committedWork: committed('committed_v42', 101),
      },
    ],
    matrix: { locationCount: durations.length, durationsSeconds: durations },
    ...overrides,
  }
}

function v83Route() {
  return {
    vehicle: 100,
    duration: 3000,
    service: 1200,
    steps: [
      { type: 'start' as const, arrival: at('13:20:00'), waiting_time: 0, service: 0, load: [0] },
      { type: 'job' as const, id: 10_000, arrival: at('13:45:00'), waiting_time: 0, service: 300, load: [240] },
      { type: 'break' as const, id: 20_000, arrival: at('15:30:00'), waiting_time: 0, service: 900, load: [240] },
      { type: 'end' as const, arrival: at('16:10:00'), waiting_time: 0, service: 0, load: [240] },
    ],
  }
}

export function feasibleVroomResponse(input: Readonly<{ arrival?: number; waiting?: number; service?: number }> = {}): VroomResponse {
  return {
    code: 0,
    unassigned: [],
    routes: [
      v83Route(),
      {
        vehicle: 101,
        duration: 3780,
        service: 2100,
        steps: [
          { type: 'start', arrival: at('13:20:00'), waiting_time: 0, service: 0, load: [0] },
          { type: 'job', id: 10_001, arrival: at('13:45:00'), waiting_time: 0, service: 300, load: [240] },
          { type: 'job', id: 900_001, arrival: input.arrival ?? at('14:24:00'), waiting_time: input.waiting ?? 0, service: input.service ?? 900, load: [480] },
          { type: 'break', id: 20_001, arrival: at('15:30:00'), waiting_time: 0, service: 900, load: [480] },
          { type: 'end', arrival: at('16:10:00'), waiting_time: 0, service: 0, load: [480] },
        ],
      },
    ],
  }
}

export function baselineVroomResponse(): VroomResponse {
  return {
    code: 0,
    unassigned: [],
    routes: [
      v83Route(),
      {
        vehicle: 101,
        duration: 3360,
        service: 1200,
        steps: [
          { type: 'start', arrival: at('13:20:00'), waiting_time: 0, service: 0, load: [0] },
          { type: 'job', id: 10_001, arrival: at('13:45:00'), waiting_time: 0, service: 300, load: [240] },
          { type: 'break', id: 20_001, arrival: at('15:30:00'), waiting_time: 0, service: 900, load: [240] },
          { type: 'end', arrival: at('16:20:00'), waiting_time: 0, service: 0, load: [240] },
        ],
      },
    ],
  }
}

export function idleSelectedVehicleRequest(): RecoveryRouteRequest {
  const request = greenleafRequest()
  return {
    ...request,
    vehicles: request.vehicles.map((vehicle) => vehicle.id === 'veh_v42'
      ? { ...vehicle, breaks: [], committedWork: [] }
      : vehicle),
  }
}

export function idleSelectedVehicleFullResponse(): VroomResponse {
  return {
    code: 0,
    unassigned: [],
    routes: [
      v83Route(),
      {
        vehicle: 101,
        duration: 480,
        service: 900,
        steps: [
          { type: 'start', arrival: at('13:56:00'), waiting_time: 0, service: 0, load: [0] },
          { type: 'job', id: 900_001, arrival: at('14:00:00'), waiting_time: 0, service: 900, load: [240] },
          { type: 'end', arrival: at('14:19:00'), waiting_time: 0, service: 0, load: [240] },
        ],
      },
    ],
  }
}

export function idleSelectedVehicleBaselineResponse(): VroomResponse {
  return { code: 0, unassigned: [], routes: [v83Route()] }
}

export class CapturingTransport implements VroomTransport {
  readonly problems: VroomProblem[] = []
  readonly #responder: (problem: VroomProblem, signal: AbortSignal) => Promise<unknown>

  constructor(responder: (problem: VroomProblem, signal: AbortSignal) => Promise<unknown>) {
    this.#responder = responder
  }

  async solve(problem: VroomProblem, signal: AbortSignal): Promise<unknown> {
    this.problems.push(problem)
    return this.#responder(problem, signal)
  }
}

export function pairedTransport(full: unknown = feasibleVroomResponse(), baseline: unknown = baselineVroomResponse()): CapturingTransport {
  return new CapturingTransport(async (problem) => structuredClone(problem.jobs.some((job) => job.id === 900_001) ? full : baseline))
}
