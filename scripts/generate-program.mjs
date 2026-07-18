import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = new URL('../content/programs/resolve-commercial-service-exception.yaml', import.meta.url)
const tsPath = new URL('../packages/contracts/src/generated/recovery-program.ts', import.meta.url)
const docsPath = new URL('../docs/reference/generated/recovery-program.md', import.meta.url)
const check = process.argv.includes('--check')

// JSON is a valid YAML 1.2 document, which keeps this compiler dependency-free.
const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
if (!source?.id || !source?.version || !Array.isArray(source.skills) || source.skills.length === 0) {
  throw new Error('program source is missing id, version, or skills')
}

const ts = `// Generated from content/programs/resolve-commercial-service-exception.yaml. Do not edit.\nexport const recoveryProgramDefinition = ${JSON.stringify({
  id: source.id,
  version: source.version,
  allowedSkills: source.skills.map((skill) => skill.id),
  outcomes: source.outcomes,
}, null, 2)} as const\n\nexport const recoverySkillDefinitions = ${JSON.stringify(source.skills, null, 2)} as const\n`

const rows = source.skills
  .map((skill) => `| \`${skill.id}\` | ${skill.description} | ${skill.access} |`)
  .join('\n')
const docs = `# ${source.title}\n\n${source.job}\n\n> Generated from \`content/programs/resolve-commercial-service-exception.yaml\`. Change the source, then run \`pnpm generate:program\`.\n\n## Possible outcomes\n\n${source.outcomes.map((outcome) => `- \`${outcome}\``).join('\n')}\n\n## Operating constraints\n\n${source.constraints.map((constraint) => `- ${constraint}`).join('\n')}\n\n## Skills\n\n| Skill | Job | Access |\n| --- | --- | --- |\n${rows}\n`

for (const [url, expected] of [[tsPath, ts], [docsPath, docs]]) {
  if (check) {
    const actual = readFileSync(url, 'utf8')
    if (actual !== expected) throw new Error(`${url.pathname} is stale; run pnpm generate:program`)
  } else {
    writeFileSync(url, expected)
  }
}
