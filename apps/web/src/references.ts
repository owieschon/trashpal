/**
 * The operator facade exposes only these reviewed technical documents. This
 * stays an explicit allowlist so Help Markdown cannot turn repository paths
 * into arbitrary browser links.
 */
export function canonicalReferenceHref(sourceHref: string): string | null {
  const references: Readonly<Record<string, string>> = {
    '../architecture/CORE_BUILD_CONTRACT.md': '/v1/operator/help/references/core-build-contract',
    '../reference/generated/recovery-program.md': '/v1/operator/help/references/recovery-program',
    '../architecture/DOMAIN_ASSUMPTIONS.md': '/v1/operator/help/references/domain-assumptions',
    '../architecture/SYNTHETIC_SEED_CORPUS.md': '/v1/operator/help/references/synthetic-seed-corpus',
  }
  return references[sourceHref] ?? null
}
