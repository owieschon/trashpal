import type { OperatorAction } from './api.js'

/** Copy is derived from the server-owned next action, never inferred from UI state. */
export function authorityMessage(action: OperatorAction | null, hasOperation: boolean): string {
  if (action === 'prepare') return 'Pal can inspect the allowed case evidence. No recovery has been prepared or approved.'
  if (action === 'approve') return 'A dispatcher must approve this exact recovery before it can be sent.'
  if (action === 'reserve') return 'The approval is recorded. Create the recovery operation from that approved record before dispatch.'
  if (action === 'dispatch') return 'The approved recovery is now a durable dispatch request. Sending it is still a separate action.'
  if (action === 'reconcile') return 'The provider outcome is uncertain. Reconcile this operation before any further action is considered.'
  if (action === 'view_receipt') return 'The operation record has a receipt ready for review.'
  if (hasOperation) return 'No additional action is available from this view. The existing operation remains the source of truth.'
  return 'Pal can inspect the allowed case evidence. No recovery has been prepared or approved.'
}
