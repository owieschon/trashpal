import { expect, test, type Page } from '@playwright/test'
import { createLifecyclePostgresPool } from '../../packages/lifecycle/src/index.js'

const localDatabaseUrl = 'postgresql://trashpal:trashpal_local_only@127.0.0.1:54329/trashpal_core_test'

async function selectCase(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click()
  await expect(page.getByRole('heading', { name: name.split(' · ')[0] ?? name })).toBeVisible()
}

async function durableCounts(): Promise<{ readonly operations: number; readonly assignments: number; readonly receipts: number; readonly state: string | null }> {
  const pool = createLifecyclePostgresPool({
    connectionString: process.env.TEST_DATABASE_URL ?? localDatabaseUrl,
    applicationName: 'trashpal-browser-workflow',
    max: 1,
    searchPath: 'trashpal_local_demo',
  })
  try {
    const result = await pool.query<{ operations: string; assignments: string; receipts: string; state: string | null }>(
      `SELECT
         (SELECT count(*)::text FROM lifecycle_operations) AS operations,
         (SELECT count(*)::text FROM lifecycle_assignments) AS assignments,
         (SELECT count(*)::text FROM lifecycle_outcome_receipts) AS receipts,
         (SELECT state FROM lifecycle_operations ORDER BY created_at DESC LIMIT 1) AS state`,
    )
    const row = result.rows[0]
    if (!row) throw new Error('The local demo did not return durable lifecycle counts.')
    return {
      operations: Number(row.operations),
      assignments: Number(row.assignments),
      receipts: Number(row.receipts),
      state: row.state,
    }
  } finally {
    await pool.end()
  }
}

test('keeps holds and decline non-operative, then creates one reconciled recovery from the UI', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open case' }).click()

  await selectCase(page, 'Riverbend Market · organics service exception Access confirmation needed needs review')
  await page.getByRole('button', { name: 'Driver reports blocked' }).click()
  await expect(page.getByRole('heading', { name: 'Resolve the access conflict' })).toBeVisible()
  await expect(page.getByText('Held for confirmation', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Prepare reviewed recovery' })).toHaveCount(0)
  await expect(page.getByText('held: blocked access', { exact: true })).toBeVisible()
  await expect.poll(durableCounts).toEqual({ operations: 0, assignments: 0, receipts: 0, state: null })

  await selectCase(page, 'Northstar Kitchen · organics service exception Recovery review queued needs review')
  await page.getByRole('button', { name: 'I cannot confirm access' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm access before recovery' })).toBeVisible()
  await expect(page.getByText('Fresh access observation recorded', { exact: true })).toBeVisible()
  await expect.poll(durableCounts).toEqual({ operations: 0, assignments: 0, receipts: 0, state: null })

  await selectCase(page, 'Greenleaf Café · organics service exception Service window closing needs review')
  await page.getByRole('button', { name: 'Access is clear' }).click()
  await expect(page.getByRole('heading', { name: 'Approve exact recovery' })).toBeVisible()

  await page.getByRole('button', { name: 'Leave unapproved' }).click()
  await expect(page.getByRole('status')).toContainText('Recovery left unapproved. No dispatch operation was created')
  await expect.poll(durableCounts).toEqual({ operations: 0, assignments: 0, receipts: 0, state: null })

  await page.getByRole('button', { name: 'Approve exact recovery' }).click()
  await expect(page.getByRole('button', { name: 'Send approved recovery' })).toBeVisible()
  await expect.poll(durableCounts).toEqual({ operations: 1, assignments: 0, receipts: 0, state: 'reserved' })

  await page.getByRole('button', { name: 'Send approved recovery' }).click()
  await expect(page.getByRole('heading', { name: 'Reconcile operation' })).toBeVisible()
  await expect(page.getByText('Dispatch uncertain', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Reconcile operation' }).click()
  await expect(page.locator('.state-chip')).toHaveText('Assignment Reconciled')
  await expect(page.getByText('Outcome recorded', { exact: true })).toBeVisible()
  await expect.poll(durableCounts).toEqual({ operations: 1, assignments: 1, receipts: 1, state: 'assignment_reconciled' })
})
