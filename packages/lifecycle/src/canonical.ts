import { createHash, timingSafeEqual } from 'node:crypto'

function sortCanonical(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not permit non-finite numbers.')
    return value
  }
  if (typeof value !== 'object') throw new TypeError('Canonical JSON accepts only JSON values.')
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not permit cyclic values.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => sortCanonical(item, ancestors))
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON objects must have a plain-object prototype.')
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortCanonical(item, ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value, new WeakSet()))
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function equalText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
