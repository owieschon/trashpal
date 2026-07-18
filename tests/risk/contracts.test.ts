import { spawnSync } from 'node:child_process'
import dns from 'node:dns/promises'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AgentRunTraceSchema,
  ModelContextEnvelopeSchema,
  ProgramDefinitionSchema,
  RunBudgetSchema,
  RunOutcomeSchema,
  SkillDefinitionSchema,
} from '../../packages/contracts/src/index.js'

const coreTestRunner = fileURLToPath(new URL('../../scripts/test-core.mjs', import.meta.url))
const coreTestPreload = new URL('../../scripts/test-core.mjs', import.meta.url).href
const validComposedEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  TEST_DATABASE_URL: 'postgresql://trashpal:trashpal_local_only@127.0.0.1:54329/trashpal_core_test',
  VROOM_URL: 'http://127.0.0.1:3000/',
  VROOM_REQUIRE_REAL: '1',
  POSTGRES_REQUIRE_REAL: '1',
}

function validateComposedEnvironment(environment: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [coreTestRunner, '--validate-environment'], {
    env: environment,
    encoding: 'utf8',
  })
}

describe('risk contracts', () => {
  it('freezes a bounded program and read-only skill contract', () => {
    const skill = SkillDefinitionSchema.parse({
      id: 'get_access_evidence',
      version: '1.0.0',
      description: 'Read current case-scoped access evidence.',
      access: 'case_scoped_read_only',
      inputSchemaId: 'case-scope@1',
      outputSchemaId: 'access-evidence@1',
    })
    const program = ProgramDefinitionSchema.parse({
      id: 'resolve-commercial-service-exception',
      version: '1.0.0',
      allowedSkills: [skill.id],
      outcomes: ['prepare_recovery', 'hold_for_confirmation', 'escalate'],
    })
    expect(program.allowedSkills).toEqual(['get_access_evidence'])
  })

  it('rejects unbounded budgets and unknown outcomes', () => {
    expect(() => RunBudgetSchema.parse({
      maxSkillCalls: 100,
      maxContextTokens: 1,
      maxLatencyMs: 1,
      maxEstimatedCostUsd: 0,
    })).toThrow()
    expect(() => RunOutcomeSchema.parse('dispatch_now')).toThrow()
  })

  it('requires trace receipts and context lineage', () => {
    expect(() => AgentRunTraceSchema.parse({
      trigger: { tenantId: 't', caseId: 'c', programId: 'p' },
      runToken: 'run',
      runBudget: { maxSkillCalls: 2, maxContextTokens: 100, maxLatencyMs: 1000, maxEstimatedCostUsd: 0 },
      skillInvocations: [{ skillId: 'inspect', runToken: 'run', status: 200 }],
      outcome: 'hold_for_confirmation',
      stoppedReason: 'missing receipt',
    })).toThrow()
    expect(() => ModelContextEnvelopeSchema.parse({
      includedEvidence: [],
      omittedEvidence: [],
      conflicts: [],
      tokenEstimate: 0,
      tokenBudget: 100,
      versions: { program: 'p@1', contextBundle: 'c@1', skills: {} },
    })).toThrow()
  })

  it('accepts only a complete real-service contract on loopback', () => {
    const result = validateComposedEnvironment(validComposedEnvironment)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('fails before Vitest when a required database or real-service flag is absent', () => {
    const absentDatabase = validateComposedEnvironment({ ...validComposedEnvironment, TEST_DATABASE_URL: '' })
    expect(absentDatabase.status).toBe(1)
    expect(absentDatabase.stderr).toContain('TEST_DATABASE_URL is required')

    const noRealVroom = validateComposedEnvironment({ ...validComposedEnvironment, VROOM_REQUIRE_REAL: '0' })
    expect(noRealVroom.status).toBe(1)
    expect(noRealVroom.stderr).toContain('VROOM_REQUIRE_REAL=1 is required')

    const absentRealPostgres = { ...validComposedEnvironment }
    delete absentRealPostgres.POSTGRES_REQUIRE_REAL
    const result = validateComposedEnvironment(absentRealPostgres)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('POSTGRES_REQUIRE_REAL=1 is required')
  })

  it('rejects remote database and solver hosts without exposing their URLs', () => {
    const remoteDatabase = 'postgresql://test@db.example.test:5432/trashpal'
    const databaseResult = validateComposedEnvironment({ ...validComposedEnvironment, TEST_DATABASE_URL: remoteDatabase })
    expect(databaseResult.status).toBe(1)
    expect(databaseResult.stderr).toContain('TEST_DATABASE_URL must target a loopback host')
    expect(databaseResult.stderr).not.toContain(remoteDatabase)

    const remoteSolver = 'http://solver.example.test/'
    const solverResult = validateComposedEnvironment({ ...validComposedEnvironment, VROOM_URL: remoteSolver })
    expect(solverResult.status).toBe(1)
    expect(solverResult.stderr).toContain('VROOM_URL must target a loopback host')
    expect(solverResult.stderr).not.toContain(remoteSolver)
  })

  it('rejects a loopback override that is not the explicit service allowlist', () => {
    const result = validateComposedEnvironment({ ...validComposedEnvironment, VROOM_URL: 'http://127.0.0.1:3001/' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VROOM_URL must match the fixed local test endpoint')
  })

  it('rejects remote Docker hosts and strips caller Docker transport overrides', () => {
    const remoteHost = spawnSync(process.execPath, [coreTestRunner, '--validate-docker-environment'], {
      env: { ...validComposedEnvironment, DOCKER_HOST: 'tcp://198.51.100.1:2376' },
      encoding: 'utf8',
    })
    expect(remoteHost.status).toBe(1)
    expect(remoteHost.stderr).toContain('DOCKER_HOST must use a local Unix socket')

    const scrubbed = spawnSync(process.execPath, [coreTestRunner, '--validate-docker-environment'], {
      env: {
        ...validComposedEnvironment,
        DOCKER_CONTEXT: 'remote-context',
        DOCKER_TLS: '1',
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: '/untrusted/certs',
      },
      encoding: 'utf8',
    })
    expect(scrubbed.status).toBe(0)
    expect(scrubbed.stderr).toBe('')
  })

  it('runs under the inherited no-egress guard', async () => {
    expect(process.env.TRASHPAL_TEST_EGRESS_GUARD).toBe('offline')
    await expect(fetch('https://example.com/')).rejects.toMatchObject({ code: 'TRASHPAL_TEST_EGRESS_BLOCKED' })
    await expect(dns.resolve('example.com')).rejects.toMatchObject({ code: 'TRASHPAL_TEST_EGRESS_BLOCKED' })
    expect(() => net.connect({ host: '198.51.100.1', port: 443 })).toThrow('Test egress guard blocks network access')
  })

  it('permits only the fixed VROOM endpoint in composed guard mode', () => {
    const program = [
      "import { connect } from 'node:net'",
      "import { request } from 'node:http'",
      "import { resolve } from 'node:dns/promises'",
      'const controller = new AbortController(); controller.abort()',
      'const run = async () => {',
      "  try { await fetch('http://127.0.0.1:3000/', { signal: controller.signal }) } catch (error) {",
      "    if (error?.code === 'TRASHPAL_TEST_EGRESS_BLOCKED' || error?.name !== 'AbortError') process.exit(2)",
      '  }',
      "  try { await fetch('http://198.51.100.1:3000/', { signal: controller.signal }) } catch (error) {",
      "    if (error?.code !== 'TRASHPAL_TEST_EGRESS_BLOCKED') process.exit(3)",
      '  }',
      "  try { connect({ host: '127.0.0.2', port: 443 }) } catch (error) {",
      "    if (error?.code !== 'TRASHPAL_TEST_EGRESS_BLOCKED') process.exit(4)",
      '  }',
      "  try { request('http://127.0.0.2:3000/') } catch (error) {",
      "    if (error?.code !== 'TRASHPAL_TEST_EGRESS_BLOCKED') process.exit(5)",
      '  }',
      "  try { await resolve('127.0.0.2') } catch (error) {",
      "    if (error?.code === 'TRASHPAL_TEST_EGRESS_BLOCKED') process.exit(0)",
      '  }',
      '  process.exit(6)',
      '}',
      'void run()',
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${coreTestPreload}`,
        TRASHPAL_TEST_EGRESS_MODE: 'composed',
      },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})
