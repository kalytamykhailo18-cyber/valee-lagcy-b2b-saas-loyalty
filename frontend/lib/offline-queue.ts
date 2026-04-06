/**
 * Offline Queue with Idempotent Sync (Step 5.4)
 *
 * Persists pending financial actions in localStorage when the server is unreachable.
 * On reconnect, syncs them using the stored action ID as an idempotency key.
 */

const QUEUE_KEY = 'offline_queue'
const TTL_HOURS_KEY = 'OFFLINE_QUEUE_TTL_HOURS'
const DEFAULT_TTL_HOURS = 24

export type ActionType = 'redeem_product' | 'scan_redemption'

export interface QueuedAction {
  actionId: string
  type: ActionType
  payload: Record<string, any>
  createdAt: string // ISO timestamp
  retryCount: number
  /** Amount that will be debited from balance when this action completes */
  debitAmount?: number
}

export interface SyncResult {
  actionId: string
  success: boolean
  expired?: boolean
  error?: string
  serverResponse?: any
}

/** Generate a UUID v4 for action IDs */
export function generateActionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getQueue(): QueuedAction[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveQueue(queue: QueuedAction[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
}

function getTtlHours(): number {
  // Could be overridden via env variable passed to client
  return DEFAULT_TTL_HOURS
}

/** Add an action to the offline queue */
export function enqueueAction(
  actionId: string,
  type: ActionType,
  payload: Record<string, any>,
  debitAmount?: number
): void {
  const queue = getQueue()

  // Prevent duplicates
  if (queue.some(a => a.actionId === actionId)) return

  queue.push({
    actionId,
    type,
    payload,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    debitAmount,
  })

  saveQueue(queue)
}

/** Remove an action from the queue */
export function dequeueAction(actionId: string): void {
  const queue = getQueue().filter(a => a.actionId !== actionId)
  saveQueue(queue)
}

/** Get all pending actions */
export function getPendingActions(): QueuedAction[] {
  return getQueue()
}

/** Get expired actions (older than TTL) */
export function getExpiredActions(): QueuedAction[] {
  const ttlMs = getTtlHours() * 60 * 60 * 1000
  const now = Date.now()
  return getQueue().filter(a => now - new Date(a.createdAt).getTime() > ttlMs)
}

/** Remove expired actions and return them for notification */
export function purgeExpiredActions(): QueuedAction[] {
  const ttlMs = getTtlHours() * 60 * 60 * 1000
  const now = Date.now()
  const queue = getQueue()
  const expired = queue.filter(a => now - new Date(a.createdAt).getTime() > ttlMs)
  const remaining = queue.filter(a => now - new Date(a.createdAt).getTime() <= ttlMs)
  saveQueue(remaining)
  return expired
}

/**
 * Calculate the total balance adjustment from locally queued items.
 * Returns the total debit amount that should be subtracted from the server balance.
 */
export function getLocalPendingBalance(): number {
  const queue = getQueue()
  return queue.reduce((sum, a) => sum + (a.debitAmount || 0), 0)
}

/** Get the count of pending actions */
export function getPendingCount(): number {
  return getQueue().length
}

/**
 * Sync all pending actions to the server.
 * Uses the stored actionId as the idempotency key via the X-Idempotency-Key header.
 *
 * @param executeFn - A function that executes the API call for a given action.
 *   It receives the action and should return the server response.
 *   It should throw on network errors (to keep the item in the queue)
 *   but NOT throw on validation errors (expired token, insufficient balance, etc.)
 */
export async function syncPendingActions(
  executeFn: (action: QueuedAction) => Promise<{ success: boolean; error?: string; [key: string]: any }>
): Promise<SyncResult[]> {
  // First, purge expired actions
  const expired = purgeExpiredActions()
  const results: SyncResult[] = expired.map(a => ({
    actionId: a.actionId,
    success: false,
    expired: true,
    error: 'Action expired (exceeded TTL)',
  }))

  const queue = getQueue()
  const remaining: QueuedAction[] = []

  for (const action of queue) {
    try {
      const response = await executeFn(action)

      if (response.success || response.error === 'already_processed') {
        // Success or already processed (idempotent) — remove from queue
        results.push({
          actionId: action.actionId,
          success: true,
          serverResponse: response,
        })
      } else {
        // Server returned a validation error (expired token, insufficient balance, etc.)
        // Remove from queue and report failure
        results.push({
          actionId: action.actionId,
          success: false,
          error: response.error || 'Server rejected the action',
          serverResponse: response,
        })
      }
    } catch (err: any) {
      // Network error — keep in queue for next sync
      action.retryCount++
      remaining.push(action)
      results.push({
        actionId: action.actionId,
        success: false,
        error: 'Network error, will retry',
      })
    }
  }

  saveQueue(remaining)
  return results
}
