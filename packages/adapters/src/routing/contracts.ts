export type ServiceWindow = Readonly<{
  startAt: string
  endAt: string
}>

export type CommittedWork = Readonly<{
  id: string
  locationIndex: number
  serviceSeconds: number
  pickupKg: number
  requiredCapabilities: readonly number[]
  timeWindows: readonly ServiceWindow[]
}>

export type RecoveryVehicle = Readonly<{
  tenantId: string
  id: string
  available: boolean
  startIndex: number
  endIndex: number
  capacityKg: number
  capabilities: readonly number[]
  shift: ServiceWindow
  breaks: readonly Readonly<{
    id: string
    serviceSeconds: number
    timeWindows: readonly ServiceWindow[]
  }>[]
  committedWork: readonly CommittedWork[]
}>

export type FixedTravelMatrix = Readonly<{
  /** Number of indexed locations represented by every matrix row and column. */
  locationCount: number
  /** Every entry is whole travel seconds, never minutes or milliseconds. */
  durationsSeconds: readonly (readonly number[])[]
}>

export type RecoveryRouteRequest = Readonly<{
  tenantId: string
  caseId: string
  requestedAt: string
  quoteValidUntil: string
  streamCapability: number
  pickupKg: number
  serviceSeconds: number
  recoveryLocationIndex: number
  confirmedAccessWindow: ServiceWindow
  vehicles: readonly RecoveryVehicle[]
  matrix: FixedTravelMatrix
}>

export type ConstraintLayer =
  | 'host_input'
  | 'host_eligibility'
  | 'vroom_solver'
  | 'host_access_postcondition'
  | 'transport'
  | 'protocol'

export type ConstraintFailure = Readonly<{
  layer: ConstraintLayer
  code:
    | 'invalid_request'
    | 'tenant_mismatch'
    | 'vehicle_unavailable'
    | 'stream_incompatible'
    | 'no_solver_assignment'
    | 'committed_work_unassigned'
    | 'committed_work_missing'
    | 'committed_work_duplicated'
    | 'committed_work_moved'
    | 'service_outside_access_window'
    | 'solver_unavailable'
    | 'solver_timeout'
    | 'malformed_solver_response'
  message: string
  vehicleId?: string
}>

export type RecoveryRouteQuote = Readonly<{
  id: string
  tenantId: string
  vehicleId: string
  serviceStart: string
  serviceEnd: string
  validUntil: string
  remainingCapacityKg: number
  incrementalMinutes: number
  hash: string
}>

export type RecoveryRouteResult =
  | Readonly<{
      status: 'feasible'
      quote: RecoveryRouteQuote
      rejectedVehicles: readonly ConstraintFailure[]
    }>
  | Readonly<{
      status: 'infeasible'
      failures: readonly ConstraintFailure[]
    }>
  | Readonly<{
      status: 'unavailable'
      retryable: boolean
      failure: ConstraintFailure
    }>

export type VroomJob = Readonly<{
  id: number
  description: string
  location_index: number
  service: number
  pickup: readonly [number]
  skills: readonly number[]
  time_windows: readonly (readonly [number, number])[]
}>

export type VroomVehicle = Readonly<{
  id: number
  description: string
  profile: 'car'
  start_index: number
  end_index: number
  capacity: readonly [number]
  skills: readonly number[]
  time_window: readonly [number, number]
  breaks: readonly Readonly<{
    id: number
    description: string
    service: number
    time_windows: readonly (readonly [number, number])[]
  }>[]
}>

export type VroomProblem = Readonly<{
  jobs: readonly VroomJob[]
  vehicles: readonly VroomVehicle[]
  matrices: Readonly<{
    car: Readonly<{
      durations: readonly (readonly number[])[]
    }>
  }>
}>

export type VroomStep = Readonly<{
  type: 'start' | 'job' | 'break' | 'end'
  id?: number
  arrival: number
  service: number
  waiting_time?: number
  load?: readonly number[]
}>

export type VroomResponse = Readonly<{
  code: number
  error?: string
  unassigned: readonly Readonly<{ id: number; type: string }>[]
  routes: readonly Readonly<{
    vehicle: number
    duration: number
    service: number
    steps: readonly VroomStep[]
  }>[]
}>

export interface VroomTransport {
  solve(problem: VroomProblem, signal: AbortSignal): Promise<unknown>
}
