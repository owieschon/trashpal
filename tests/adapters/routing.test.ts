import { describe, expect, test } from 'vitest'
import { encodeVroomProblem, HttpVroomTransport, VroomRecoveryRoutePlanner, type RecoveryRouteRequest, type VroomProblem } from '../../packages/adapters/src/index.js'
import {
  baselineVroomResponse,
  CapturingTransport,
  feasibleVroomResponse,
  greenleafRequest,
  idleSelectedVehicleBaselineResponse,
  idleSelectedVehicleFullResponse,
  idleSelectedVehicleRequest,
  pairedTransport,
} from './routing-fixture.js'

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T
type MutableResponse = DeepMutable<ReturnType<typeof feasibleVroomResponse>>

describe('VROOM recovery adapter', () => {
  test('encodes explicit units, commitments, shifts, breaks, capacity, and fixed matrices', () => {
    const encoded = encodeVroomProblem(greenleafRequest())
    expect(encoded.rejectedVehicles).toEqual([
      expect.objectContaining({ layer: 'host_eligibility', code: 'stream_incompatible', vehicleId: 'veh_v17' }),
    ])
    expect(encoded.problem.vehicles).toHaveLength(2)
    expect(encoded.problem.vehicles[0]).toMatchObject({
      description: 'veh_v83', capacity: [390], skills: [101, 102],
      time_window: [1784658000, 1784671200],
      breaks: [{ service: 900, time_windows: [[1784665800, 1784667600]] }],
    })
    expect(encoded.problem.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'veh_v83:committed_v83', service: 300, pickup: [240], skills: [101, 102] }),
      expect.objectContaining({ id: 900_001, description: 'recovery:case_0881', service: 900, pickup: [240], skills: [101] }),
    ]))
    expect(encoded.problem.matrices.car.durations).toEqual(greenleafRequest().matrix.durationsSeconds)
  })

  test('does not expose an encoding path around timestamp validation', () => {
    expect(() => encodeVroomProblem(greenleafRequest({ requestedAt: '2026-07-21 13:20:00' })))
      .toThrow('invalid recovery route request')
  })

  test('quotes the real incremental delta against committed work, not a local leg estimate', async () => {
    const transport = pairedTransport()
    const result = await new VroomRecoveryRoutePlanner(transport).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({
      status: 'feasible',
      quote: {
        tenantId: 'ten_harborworks', vehicleId: 'veh_v42',
        serviceStart: '2026-07-21T19:24:00.000Z', serviceEnd: '2026-07-21T19:39:00.000Z',
        validUntil: '2026-07-21T20:00:00.000Z', remainingCapacityKg: 190, incrementalMinutes: 22,
      },
    })
    expect(transport.problems).toHaveLength(2)
    expect(transport.problems[0]?.jobs.some((job) => job.id === 900_001)).toBe(true)
    expect(transport.problems[1]?.jobs.some((job) => job.id === 900_001)).toBe(false)
  })

  test('uses a zero baseline when the selected vehicle has no committed work', async () => {
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(
      idleSelectedVehicleFullResponse(),
      idleSelectedVehicleBaselineResponse(),
    )).quoteRecovery(idleSelectedVehicleRequest())
    expect(result).toMatchObject({
      status: 'feasible',
      quote: {
        vehicleId: 'veh_v42',
        serviceStart: '2026-07-21T19:00:00.000Z',
        serviceEnd: '2026-07-21T19:15:00.000Z',
        remainingCapacityKg: 430,
        incrementalMinutes: 23,
      },
    })
  })

  test('uses arrival plus waiting time as service start and validates returned service duration', async () => {
    const arrival = Math.floor(Date.parse('2026-07-21T13:50:00-05:00') / 1_000)
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(feasibleVroomResponse({ arrival, waiting: 34 * 60 }))).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({ status: 'feasible', quote: { serviceStart: '2026-07-21T19:24:00.000Z', serviceEnd: '2026-07-21T19:39:00.000Z' } })

    const wrongService = await new VroomRecoveryRoutePlanner(pairedTransport(feasibleVroomResponse({ service: 899 }))).quoteRecovery(greenleafRequest())
    expect(wrongService).toMatchObject({ status: 'unavailable', failure: { layer: 'protocol', code: 'malformed_solver_response' } })
  })

  test('attributes unavailable vehicle to host and recovery capacity infeasibility to VROOM', async () => {
    const request = greenleafRequest({ vehicles: greenleafRequest().vehicles.map((vehicle) => vehicle.id === 'veh_v42' ? { ...vehicle, available: false } : vehicle) })
    const v83Only = {
      code: 0, unassigned: [{ id: 900_001, type: 'job' }],
      routes: [baselineVroomResponse().routes[0]],
    }
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(v83Only)).quoteRecovery(request)
    expect(result).toMatchObject({ status: 'infeasible' })
    if (result.status !== 'infeasible') throw new Error('expected infeasible')
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'host_eligibility', code: 'vehicle_unavailable', vehicleId: 'veh_v42' }),
      expect.objectContaining({ layer: 'vroom_solver', code: 'no_solver_assignment' }),
    ]))
  })

  test.each([
    ['missing', (response: MutableResponse) => { response.routes[1]!.steps = response.routes[1]!.steps.filter((step) => step.id !== 10_001) }, 'committed_work_missing'],
    ['duplicated', (response: MutableResponse) => { response.routes[0]!.steps.push(structuredClone(response.routes[1]!.steps[1]!)) }, 'committed_work_duplicated'],
    ['moved', (response: MutableResponse) => { const step = response.routes[1]!.steps.splice(1, 1)[0]!; response.routes[0]!.steps.push(step) }, 'committed_work_moved'],
  ] as const)('rejects %s committed work in the solver response', async (_label, mutate, code) => {
    const response = structuredClone(feasibleVroomResponse()) as MutableResponse
    mutate(response)
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(response)).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({ status: 'unavailable', retryable: false, failure: { layer: 'protocol', code } })
  })

  test('rejects committed work that VROOM explicitly leaves unassigned', async () => {
    const response = structuredClone(feasibleVroomResponse()) as MutableResponse
    response.routes[1]!.steps = response.routes[1]!.steps.filter((step) => step.id !== 10_001)
    response.unassigned.push({ id: 10_001, type: 'job' })
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(response)).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({ status: 'infeasible', failures: expect.arrayContaining([expect.objectContaining({ layer: 'vroom_solver', code: 'committed_work_unassigned', vehicleId: 'veh_v42' })]) })
  })

  test('reserves collision-free internal skills for committed-work pinning', () => {
    const request = greenleafRequest({
      streamCapability: 500_000,
      vehicles: greenleafRequest().vehicles.map((vehicle) => ({
        ...vehicle,
        capabilities: vehicle.id === 'veh_v17' ? vehicle.capabilities : [500_000],
        committedWork: vehicle.committedWork.map((work) => ({
          ...work,
          requiredCapabilities: vehicle.id === 'veh_v17' ? work.requiredCapabilities : [500_000],
        })),
      })),
    })
    const encoded = encodeVroomProblem(request)
    const pinSkills = encoded.problem.vehicles.map((vehicle) => vehicle.skills.at(-1))
    expect(pinSkills).toEqual([500_001, 500_002])
    expect(new Set(pinSkills).size).toBe(pinSkills.length)
  })

  test('rejects solver mutation of committed service', async () => {
    const response = structuredClone(feasibleVroomResponse()) as MutableResponse
    response.routes[1]!.steps[1]!.service = 299
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(response)).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({ status: 'unavailable', retryable: false, failure: { layer: 'protocol', code: 'malformed_solver_response' } })
  })

  test('rejects a service end outside access after applying solver waiting time', async () => {
    const arrival = Math.floor(Date.parse('2026-07-21T15:50:00-05:00') / 1_000)
    const result = await new VroomRecoveryRoutePlanner(pairedTransport(feasibleVroomResponse({ arrival }))).quoteRecovery(greenleafRequest())
    expect(result).toMatchObject({ status: 'infeasible', failures: expect.arrayContaining([expect.objectContaining({ layer: 'host_access_postcondition', code: 'service_outside_access_window', vehicleId: 'veh_v42' })]) })
  })

  test('distinguishes transport deadline and malformed numeric protocol', async () => {
    const unavailable = await new VroomRecoveryRoutePlanner(new CapturingTransport(async () => { throw new Error('offline') })).quoteRecovery(greenleafRequest())
    expect(unavailable).toMatchObject({ status: 'unavailable', retryable: true, failure: { layer: 'transport', code: 'solver_unavailable' } })

    const timeoutTransport = new CapturingTransport((_problem: VroomProblem, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const timeout = await new VroomRecoveryRoutePlanner(timeoutTransport, { timeoutMs: 5 }).quoteRecovery(greenleafRequest())
    expect(timeout).toMatchObject({ status: 'unavailable', retryable: true, failure: { layer: 'transport', code: 'solver_timeout' } })

    const malformed = structuredClone(feasibleVroomResponse()) as MutableResponse
    malformed.routes[1]!.steps[2]!.waiting_time = -1
    const malformedResult = await new VroomRecoveryRoutePlanner(pairedTransport(malformed)).quoteRecovery(greenleafRequest())
    expect(malformedResult).toMatchObject({ status: 'unavailable', retryable: false, failure: { layer: 'protocol', code: 'malformed_solver_response' } })
  })

  test.each([
    ['expired quote', { requestedAt: '2026-07-21T15:00:00-05:00', quoteValidUntil: '2026-07-21T15:00:00-05:00' }],
    ['timestamp without offset', { requestedAt: '2026-07-21T13:20:00' }],
    ['fractional timestamp', { requestedAt: '2026-07-21T13:20:00.000-05:00' }],
    ['impossible calendar date', { requestedAt: '2026-02-30T13:20:00-05:00' }],
    ['mismatched matrix count', { matrix: { locationCount: 2, durationsSeconds: [[0]] } }],
    ['fractional matrix seconds', { matrix: { locationCount: 1, durationsSeconds: [[0.5]] } }],
    ['empty capabilities', { vehicles: [{ ...greenleafRequest().vehicles[0]!, capabilities: [] }] }],
    ['non-increasing shift', { vehicles: [{ ...greenleafRequest().vehicles[0]!, shift: { startAt: '2026-07-21T17:00:00-05:00', endAt: '2026-07-21T13:00:00-05:00' } }] }],
    ['duplicated committed ID', { vehicles: greenleafRequest().vehicles.map((vehicle, index) => index < 2 ? { ...vehicle, committedWork: [{ ...vehicle.committedWork[0]!, id: 'same' }] } : vehicle) }],
  ] as Array<[string, Partial<RecoveryRouteRequest>]>)('fails %s in host validation before VROOM', async (_label, override) => {
    const transport = pairedTransport()
    const result = await new VroomRecoveryRoutePlanner(transport).quoteRecovery(greenleafRequest(override))
    expect(result).toMatchObject({ status: 'infeasible', failures: expect.arrayContaining([expect.objectContaining({ layer: 'host_input', code: 'invalid_request' })]) })
    expect(transport.problems).toHaveLength(0)
  })
})

const realTest = process.env.VROOM_REQUIRE_REAL === '1' ? test : test.skip
realTest('solves full and committed-work baseline through the required real VROOM service', async () => {
  const endpoint = process.env.VROOM_URL ?? 'http://127.0.0.1:3000/'
  const result = await new VroomRecoveryRoutePlanner(new HttpVroomTransport(endpoint), { timeoutMs: 20_000 }).quoteRecovery(greenleafRequest())
  expect(result).toMatchObject({
    status: 'feasible',
    quote: {
      vehicleId: 'veh_v42', serviceStart: '2026-07-21T19:24:00.000Z', serviceEnd: '2026-07-21T19:39:00.000Z',
      remainingCapacityKg: 190, incrementalMinutes: 22,
    },
  })
})

realTest('solves recovery for an idle selected vehicle against a zero baseline', async () => {
  const endpoint = process.env.VROOM_URL ?? 'http://127.0.0.1:3000/'
  const result = await new VroomRecoveryRoutePlanner(new HttpVroomTransport(endpoint), { timeoutMs: 20_000 }).quoteRecovery(idleSelectedVehicleRequest())
  expect(result).toMatchObject({
    status: 'feasible',
    quote: { vehicleId: 'veh_v42', remainingCapacityKg: 430, incrementalMinutes: 23 },
  })
})
