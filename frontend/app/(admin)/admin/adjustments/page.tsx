'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function ManualAdjustments() {
  const [form, setForm] = useState({ accountId: '', tenantId: '', amount: '', direction: 'credit', reason: '', assetTypeId: '' })
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    setResult(null)
    setLoading(true)
    try {
      const data = await api.manualAdjustment(form)
      setResult({ success: true, ...data })
      setForm({ ...form, amount: '', reason: '' })
    } catch (e: any) {
      setResult({ success: false, error: e.error || 'Error applying adjustment' })
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin" className="text-slate-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold">Manual Adjustment</h1>
      </div>

      <div className="bg-white rounded-2xl p-6 shadow-sm max-w-lg space-y-4">
        <p className="text-sm text-slate-500">Apply a manual correction to a consumer account. This creates a double-entry ledger event.</p>

        <input type="text" placeholder="Tenant ID" value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border text-sm" />
        <input type="text" placeholder="Account ID" value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border text-sm" />
        <input type="text" placeholder="Asset Type ID" value={form.assetTypeId} onChange={e => setForm({ ...form, assetTypeId: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border text-sm" />

        <div className="flex gap-3">
          <input type="number" placeholder="Amount" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
            className="flex-1 px-3 py-2 rounded-lg border text-sm" />
          <select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })}
            className="px-3 py-2 rounded-lg border text-sm">
            <option value="credit">Credit (+)</option>
            <option value="debit">Debit (-)</option>
          </select>
        </div>

        <textarea placeholder="Reason (mandatory, min 5 chars)" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border text-sm h-20 resize-none" />

        {result && (
          <div className={`text-sm p-3 rounded-lg ${result.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {result.success ? `Adjustment applied. New balance: ${result.newBalance}` : result.error}
          </div>
        )}

        <button onClick={handleSubmit} disabled={loading || !form.accountId || !form.tenantId || !form.amount || form.reason.length < 5}
          className="w-full bg-slate-800 text-white py-3 rounded-xl font-medium disabled:opacity-50 transition">
          {loading ? 'Applying...' : 'Apply Adjustment'}
        </button>
      </div>
    </div>
  )
}
