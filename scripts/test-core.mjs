#!/usr/bin/env node
/**
 * The single entry point for the offline and composed core test modes.
 *
 * It also acts as the NODE_OPTIONS preload used by Vitest workers. Offline
 * mode permits no network access. Composed mode permits only the two pinned
 * loopback fixtures; it never accepts caller-selected endpoints.
 */
import { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import tls from 'node:tls'

export const LOCAL_TEST_DATABASE_URL = 'postgresql://trashpal:trashpal_local_only@127.0.0.1:54329/trashpal_core_test'
export const LOCAL_VROOM_URL = 'http://127.0.0.1:3000/'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const composeScript = resolve(root, 'scripts/compose.sh')
const preload = pathToFileURL(fileURLToPath(import.meta.url)).href
const guardKey = Symbol.for('trashpal.test-egress-guard')
const offlineTargets = [
  'tests/contracts',
  'tests/context',
  'tests/agent',
  'tests/evals',
  'tests/adapters',
  'tests/lifecycle/approval.test.ts',
  'tests/lifecycle/authority.test.ts',
  'tests/lifecycle/black-box.test.ts',
  'tests/lifecycle/migration.test.ts',
  'tests/lifecycle/reconciliation.test.ts',
  'tests/docs-agent-drift',
  'tests/testkit',
  'tests/risk',
]
const allowedDnsNames = new Set(['localhost', '127.0.0.1', '::1'])

export class ComposedTestConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ComposedTestConfigurationError'
  }
}

function blocked(operation) {
  const error = new Error(`Test egress guard blocks network access (${operation}).`)
  error.code = 'TRASHPAL_TEST_EGRESS_BLOCKED'
  return error
}

const normalizedHost = (value) => String(value).toLowerCase().replace(/^\[|\]$/g, '')
const loopbackDnsName = (hostname) => allowedDnsNames.has(normalizedHost(hostname))

function connectionEndpoint(args) {
  const normalizedArgs = Array.isArray(args[0]) ? args[0] : args
  const first = normalizedArgs[0]
  if (typeof first === 'number') {
    return { host: typeof normalizedArgs[1] === 'string' ? normalizedArgs[1] : '', port: first }
  }
  if (first && typeof first === 'object') {
    return {
      host: first.host ?? first.hostname ?? '',
      port: first.port ?? '',
    }
  }
  return { host: '', port: '' }
}

function endpointAllowed(mode, host, port) {
  if (mode !== 'composed' || normalizedHost(host) !== '127.0.0.1') return false
  const endpoint = `127.0.0.1:${Number(port)}`
  return endpoint === '127.0.0.1:54329' || endpoint === '127.0.0.1:3000'
}

function urlFromRequest(args) {
  const first = args[0]
  try {
    if (first instanceof URL) return first
    if (typeof first === 'string') return new URL(first)
    if (first && typeof first === 'object' && typeof first.href === 'string') return new URL(first.href)
    if (first && typeof first === 'object') {
      const protocol = first.protocol ?? 'http:'
      const host = first.hostname ?? first.host
      const port = first.port ? `:${first.port}` : ''
      if (typeof host === 'string') return new URL(`${protocol}//${host}${port}/`)
    }
  } catch {
    // Deny malformed caller input without reflecting it in the error.
  }
  return undefined
}

/**
 * Install the guard once per process, then synchronize built-in ESM exports so
 * named imports such as `import { connect } from 'node:net'` cannot bypass it.
 */
export function installNoEgressGuard(mode = process.env.TRASHPAL_TEST_EGRESS_MODE ?? 'offline') {
  if (mode !== 'offline' && mode !== 'composed') {
    throw new ComposedTestConfigurationError('TRASHPAL_TEST_EGRESS_MODE must be "offline" or "composed".')
  }
  if (globalThis[guardKey]) return

  globalThis[guardKey] = true
  process.env.TRASHPAL_TEST_EGRESS_GUARD = mode

  const originalFetch = globalThis.fetch.bind(globalThis)
  const originalLookup = dns.lookup.bind(dns)
  const originalPromiseLookup = dnsPromises.lookup.bind(dnsPromises)
  const originalNetConnect = net.connect.bind(net)
  const originalCreateConnection = net.createConnection.bind(net)
  const originalSocketConnect = net.Socket.prototype.connect
  const originalHttpRequest = http.request.bind(http)
  const originalHttpGet = http.get.bind(http)

  const throwBlocked = (operation) => () => {
    throw blocked(operation)
  }
  const rejectBlocked = (operation) => async () => {
    throw blocked(operation)
  }
  const assertAllowedConnection = (args, operation) => {
    const endpoint = connectionEndpoint(args)
    if (!endpointAllowed(mode, endpoint.host, endpoint.port)) throw blocked(operation)
  }
  const assertAllowedHttp = (args, operation) => {
    const endpoint = urlFromRequest(args)
    if (!endpoint || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password
      || !endpointAllowed(mode, endpoint.hostname, endpoint.port || 80)) {
      throw blocked(operation)
    }
  }

  globalThis.fetch = async (input, init) => {
    assertAllowedHttp([input], 'fetch')
    return await originalFetch(input, init)
  }
  globalThis.WebSocket = class BlockedWebSocket {
    constructor() {
      throw blocked('WebSocket')
    }
  }
  net.connect = (...args) => {
    assertAllowedConnection(args, 'net.connect')
    return originalNetConnect(...args)
  }
  net.createConnection = (...args) => {
    assertAllowedConnection(args, 'net.createConnection')
    return originalCreateConnection(...args)
  }
  net.Socket.prototype.connect = function (...args) {
    assertAllowedConnection(args, 'net.Socket.connect')
    return originalSocketConnect.apply(this, args)
  }
  tls.connect = throwBlocked('tls.connect')
  dgram.createSocket = throwBlocked('dgram.createSocket')
  http.request = (...args) => {
    assertAllowedHttp(args, 'http.request')
    return originalHttpRequest(...args)
  }
  http.get = (...args) => {
    assertAllowedHttp(args, 'http.get')
    return originalHttpGet(...args)
  }
  https.request = throwBlocked('https.request')
  https.get = throwBlocked('https.get')
  http2.connect = throwBlocked('http2.connect')

  // `lookup()` can resolve literal loopback names locally. All resolver APIs
  // that could query nameservers remain unavailable in both modes.
  const lookupLocalOnly = (lookup, operation) => (hostname, ...args) => {
    if (!loopbackDnsName(hostname)) throw blocked(operation)
    return lookup(hostname, ...args)
  }
  dns.lookup = lookupLocalOnly(originalLookup, 'dns.lookup')
  dnsPromises.lookup = lookupLocalOnly(originalPromiseLookup, 'dns.promises.lookup')
  for (const method of [
    'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
    'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
    'resolveSrv', 'resolveTxt', 'reverse', 'lookupService',
  ]) {
    if (typeof dns[method] === 'function') dns[method] = throwBlocked(`dns.${method}`)
    if (typeof dnsPromises[method] === 'function') dnsPromises[method] = rejectBlocked(`dns.promises.${method}`)
  }

  syncBuiltinESMExports()
}

/**
 * Only loopback literals/names are valid candidates before exact fixed endpoint
 * checks. This helper is exported for focused configuration regression tests.
 */
export function isLoopbackHostname(hostname) {
  const normalized = normalizedHost(hostname)
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

function parseEndpoint(value, label, protocols) {
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new ComposedTestConfigurationError(`${label} must be a valid local URL.`)
  }
  if (!protocols.includes(endpoint.protocol)) {
    throw new ComposedTestConfigurationError(`${label} must use ${protocols.join(' or ')}.`)
  }
  if (!isLoopbackHostname(endpoint.hostname)) {
    throw new ComposedTestConfigurationError(`${label} must target a loopback host.`)
  }
  return endpoint
}

export function assertComposedTestEnvironment(environment) {
  const databaseUrl = environment.TEST_DATABASE_URL
  if (!databaseUrl) {
    throw new ComposedTestConfigurationError('TEST_DATABASE_URL is required for composed tests.')
  }
  const vroomUrl = environment.VROOM_URL
  if (!vroomUrl) {
    throw new ComposedTestConfigurationError('VROOM_URL is required for composed tests.')
  }
  if (environment.VROOM_REQUIRE_REAL !== '1') {
    throw new ComposedTestConfigurationError('VROOM_REQUIRE_REAL=1 is required for composed tests.')
  }
  if (environment.POSTGRES_REQUIRE_REAL !== '1') {
    throw new ComposedTestConfigurationError('POSTGRES_REQUIRE_REAL=1 is required for composed tests.')
  }
  parseEndpoint(databaseUrl, 'TEST_DATABASE_URL', ['postgres:', 'postgresql:'])
  parseEndpoint(vroomUrl, 'VROOM_URL', ['http:'])
}

/**
 * Reject all caller-selected fixture locations, including alternate loopback
 * ports. The runner subsequently supplies this immutable contract to Vitest.
 */
export function assertCallerOverridesAreLocal(environment) {
  if (environment.TEST_DATABASE_URL) {
    const endpoint = parseEndpoint(environment.TEST_DATABASE_URL, 'TEST_DATABASE_URL', ['postgres:', 'postgresql:'])
    if (endpoint.toString() !== LOCAL_TEST_DATABASE_URL) {
      throw new ComposedTestConfigurationError('TEST_DATABASE_URL must match the fixed local test endpoint.')
    }
  }
  if (environment.VROOM_URL) {
    const endpoint = parseEndpoint(environment.VROOM_URL, 'VROOM_URL', ['http:'])
    if (endpoint.toString() !== LOCAL_VROOM_URL) {
      throw new ComposedTestConfigurationError('VROOM_URL must match the fixed local test endpoint.')
    }
  }
  if (environment.VROOM_REQUIRE_REAL !== undefined && environment.VROOM_REQUIRE_REAL !== '1') {
    throw new ComposedTestConfigurationError('VROOM_REQUIRE_REAL=1 is required for composed tests.')
  }
  if (environment.POSTGRES_REQUIRE_REAL !== undefined && environment.POSTGRES_REQUIRE_REAL !== '1') {
    throw new ComposedTestConfigurationError('POSTGRES_REQUIRE_REAL=1 is required for composed tests.')
  }
}

export function localComposedTestEnvironment(environment) {
  assertCallerOverridesAreLocal(environment)
  const configured = {
    ...environment,
    TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL,
    VROOM_URL: LOCAL_VROOM_URL,
    VROOM_REQUIRE_REAL: '1',
    POSTGRES_REQUIRE_REAL: '1',
  }
  assertComposedTestEnvironment(configured)
  return configured
}

function noEgressWorkerEnvironment(environment, mode) {
  return {
    ...environment,
    TRASHPAL_TEST_EGRESS_MODE: mode,
    // Do not retain caller preloads. A test worker's network boundary is
    // established only by this runner's audited preload.
    NODE_OPTIONS: `--import=${preload}`,
  }
}

function command(commandName, args, environment) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${commandName} exited with status ${result.status ?? 'unknown'}.`)
}

function localDockerEnvironment(environment) {
  if (environment.DOCKER_HOST && !environment.DOCKER_HOST.startsWith('unix://')) {
    throw new ComposedTestConfigurationError('DOCKER_HOST must use a local Unix socket for composed tests.')
  }
  const configured = { ...environment }
  delete configured.DOCKER_HOST
  delete configured.DOCKER_CONTEXT
  delete configured.DOCKER_TLS
  delete configured.DOCKER_TLS_VERIFY
  delete configured.DOCKER_CERT_PATH
  return configured
}

function assertCurrentDockerContextIsLocal(environment) {
  const result = spawnSync('docker', ['context', 'inspect', '--format', '{{ .Endpoints.docker.Host }}'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    shell: false,
  })
  if (result.error || result.status !== 0 || !result.stdout.trim().startsWith('unix://')) {
    throw new ComposedTestConfigurationError('Docker must resolve to a local Unix-socket context for composed tests.')
  }
}

function bootstrapLocalServices(environment) {
  const mode = environment.TRASHPAL_COMPOSED_TEST_SERVICES ?? 'compose'
  if (mode === 'provided') return
  if (mode !== 'compose') {
    throw new ComposedTestConfigurationError('TRASHPAL_COMPOSED_TEST_SERVICES must be "compose" or "provided".')
  }
  const dockerEnvironment = localDockerEnvironment(environment)
  assertCurrentDockerContextIsLocal(dockerEnvironment)
  // Missing pinned images fail the test. The runner never pulls an image or
  // falls back to a caller-provided service.
  command(composeScript, [
    '-f', 'infra/compose.core.yml', 'up', '--detach', '--wait', '--pull', 'never', 'postgres', 'vroom',
  ], dockerEnvironment)
}

export function runOfflineTests(environment = process.env) {
  const configured = { ...environment }
  for (const key of [
    'TEST_DATABASE_URL', 'VROOM_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]) delete configured[key]
  configured.VROOM_REQUIRE_REAL = '0'
  configured.POSTGRES_REQUIRE_REAL = '0'
  const testEnvironment = noEgressWorkerEnvironment(configured, 'offline')
  command(process.execPath, ['scripts/generate-program.mjs', '--check'], testEnvironment)
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  command(pnpm, ['exec', 'vitest', 'run', ...offlineTargets], testEnvironment)
}

export function runComposedTests(environment = process.env) {
  const configured = localComposedTestEnvironment(environment)
  bootstrapLocalServices(configured)
  const testEnvironment = noEgressWorkerEnvironment(configured, 'composed')
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  command(pnpm, [
    'exec', 'vitest', 'run',
    'tests/composed',
    'tests/operator',
    'tests/lifecycle/postgres.integration.test.ts',
  ], testEnvironment)
}

function main(args) {
  const [mode, ...flags] = args
  // The validation commands are intentionally accepted without a mode for
  // direct, focused regression subprocesses.
  const composedMode = mode === 'composed' || mode === '--validate-environment' || mode === '--validate-docker-environment'
  const effectiveFlags = composedMode && mode.startsWith('--') ? [mode, ...flags] : flags
  if (effectiveFlags.includes('--validate-environment')) {
    assertCallerOverridesAreLocal(process.env)
    assertComposedTestEnvironment(process.env)
    return
  }
  if (effectiveFlags.includes('--validate-docker-environment')) {
    const configured = localDockerEnvironment(process.env)
    if (configured.DOCKER_HOST || configured.DOCKER_CONTEXT || configured.DOCKER_TLS || configured.DOCKER_TLS_VERIFY || configured.DOCKER_CERT_PATH) {
      throw new ComposedTestConfigurationError('Composed Docker bootstrap retained a caller transport override.')
    }
    return
  }
  if (mode === 'offline') return runOfflineTests()
  if (mode === 'composed') return runComposedTests()
  throw new ComposedTestConfigurationError('Usage: node scripts/test-core.mjs <offline|composed>.')
}

// Preload execution must occur before a test worker's entry module runs.
if (process.env.TRASHPAL_TEST_EGRESS_MODE) installNoEgressGuard()

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Core test runner failed.'
    process.stderr.write(`core test runner: ${message}\n`)
    process.exitCode = 1
  }
}
