import type { ConstraintFailure, RecoveryRouteRequest, RecoveryVehicle } from './contracts.js'

function finiteWholeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0
}

function validInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[9] === undefined ? 0 : Number(match[9])
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const
  const daysInMonth = monthLengths[month - 1] ?? 0
  return year >= 1
    && day >= 1
    && day <= daysInMonth
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value))
}

function increasingWindow(window: Readonly<{ startAt: string; endAt: string }>): boolean {
  return validInstant(window.startAt) && validInstant(window.endAt) && Date.parse(window.startAt) < Date.parse(window.endAt)
}

function integerCapabilities(values: readonly number[]): boolean {
  return values.length > 0
    && values.every((value) => finiteWholeNonnegative(value) && value <= 1_000_000_000)
    && new Set(values).size === values.length
}

export function validateRouteRequest(request: RecoveryRouteRequest): ConstraintFailure[] {
  const failures: ConstraintFailure[] = []
  const matrixSize = request.matrix.locationCount
  const validWindow = increasingWindow(request.confirmedAccessWindow)

  if (!request.tenantId || !request.caseId || !validInstant(request.requestedAt) || !validInstant(request.quoteValidUntil)) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'tenant, case, and valid timestamps are required' })
  }
  if (validInstant(request.requestedAt) && validInstant(request.quoteValidUntil) && Date.parse(request.requestedAt) >= Date.parse(request.quoteValidUntil)) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'quote validity must extend beyond the request time' })
  }
  if (!validWindow || !finiteWholeNonnegative(request.pickupKg) || request.pickupKg === 0 || !finiteWholeNonnegative(request.serviceSeconds) || request.serviceSeconds === 0) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'access, pickup kilograms, and service seconds must be explicit and valid' })
  }
  if (!finiteWholeNonnegative(request.streamCapability) || request.streamCapability > 1_000_000_000) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'stream capability must be a bounded whole nonnegative integer' })
  }
  if (!Number.isSafeInteger(request.recoveryLocationIndex) || request.recoveryLocationIndex < 0 || request.recoveryLocationIndex >= matrixSize) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'recovery location index is outside the fixed matrix' })
  }
  if (!Number.isSafeInteger(matrixSize)
    || matrixSize <= 0
    || request.matrix.durationsSeconds.length !== matrixSize
    || request.matrix.durationsSeconds.some((row) => row.length !== matrixSize || row.some((duration) => !finiteWholeNonnegative(duration)))) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'travel matrix must declare its indexed location count and contain square whole nonnegative seconds' })
  }
  if (validWindow && Date.parse(request.confirmedAccessWindow.endAt) - Date.parse(request.confirmedAccessWindow.startAt) < request.serviceSeconds * 1_000) {
    failures.push({ layer: 'host_input', code: 'invalid_request', message: 'confirmed access window is shorter than service duration' })
  }
  if (request.vehicles.length === 0) failures.push({ layer: 'host_input', code: 'invalid_request', message: 'at least one vehicle is required' })

  const vehicleIds = new Set<string>()
  const committedIds = new Set<string>()
  for (const vehicle of request.vehicles) {
    if (!vehicle.id || vehicleIds.has(vehicle.id)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle IDs must be nonempty and unique' })
    vehicleIds.add(vehicle.id)
    if (!vehicle.tenantId) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle tenant is required' })
    if (!finiteWholeNonnegative(vehicle.capacityKg) || vehicle.capacityKg === 0) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle capacity must be whole positive kilograms' })
    if (!integerCapabilities(vehicle.capabilities)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle capabilities must be nonempty unique whole integers' })
    if (![vehicle.startIndex, vehicle.endIndex].every((index) => finiteWholeNonnegative(index) && index < matrixSize)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle start and end indexes must be inside the fixed matrix' })
    if (!increasingWindow(vehicle.shift)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'vehicle shift must have increasing timestamps' })

    const breakIds = new Set<string>()
    for (const item of vehicle.breaks) {
      if (!item.id || breakIds.has(item.id)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'break IDs must be nonempty and unique per vehicle' })
      breakIds.add(item.id)
      if (!finiteWholeNonnegative(item.serviceSeconds) || item.serviceSeconds === 0 || item.timeWindows.length === 0 || item.timeWindows.some((window) => !increasingWindow(window))) {
        failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'breaks require positive whole service seconds and increasing windows' })
      }
    }

    for (const work of vehicle.committedWork) {
      if (!work.id || committedIds.has(work.id)) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'committed-work IDs must be nonempty and globally unique' })
      committedIds.add(work.id)
      if (!finiteWholeNonnegative(work.locationIndex) || work.locationIndex >= matrixSize) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'committed-work location must be inside the fixed matrix' })
      if (!finiteWholeNonnegative(work.pickupKg) || !finiteWholeNonnegative(work.serviceSeconds) || work.serviceSeconds === 0) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'committed work requires whole nonnegative kilograms and positive whole service seconds' })
      if (!integerCapabilities(work.requiredCapabilities) || work.requiredCapabilities.some((capability) => !vehicle.capabilities.includes(capability))) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'committed-work capabilities must be nonempty and owned by the pinned vehicle' })
      if (work.timeWindows.length === 0 || work.timeWindows.some((window) => !increasingWindow(window))) failures.push({ layer: 'host_input', code: 'invalid_request', vehicleId: vehicle.id, message: 'committed work requires increasing time windows' })
    }
  }
  return failures
}

export function vehicleEligibility(request: RecoveryRouteRequest, vehicle: RecoveryVehicle): ConstraintFailure[] {
  const failures: ConstraintFailure[] = []
  if (vehicle.tenantId !== request.tenantId) {
    failures.push({ layer: 'host_eligibility', code: 'tenant_mismatch', vehicleId: vehicle.id, message: 'vehicle belongs to another tenant' })
  }
  if (!vehicle.available) {
    failures.push({ layer: 'host_eligibility', code: 'vehicle_unavailable', vehicleId: vehicle.id, message: 'vehicle is not available for recovery work' })
  }
  if (Date.parse(request.requestedAt) >= Date.parse(vehicle.shift.endAt)) {
    failures.push({ layer: 'host_eligibility', code: 'vehicle_unavailable', vehicleId: vehicle.id, message: 'vehicle shift has ended' })
  }
  if (!vehicle.capabilities.includes(request.streamCapability)) {
    failures.push({ layer: 'host_eligibility', code: 'stream_incompatible', vehicleId: vehicle.id, message: 'vehicle lacks the required stream capability' })
  }
  return failures
}
