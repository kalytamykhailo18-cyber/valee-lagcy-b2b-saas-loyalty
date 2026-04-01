'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function LedgerAudit() {
  const [entries, setEntries] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState({ tenantId: '', eventType: '', limit: '50', offset: '0' })
  const [hashResult, setHashResult] = useState<any>(null)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => { loadLedger() }, [])

  async function loadLedger() {
    try {
      const params: Record<string, string> = {}
      if (filters.tenantId) params.tenantId = filters.tenantId
      if (filters.eventType) params.eventType = filters.eventType
      params.limit = filters.limit
      params.offset = filters.offset

      const data = await api.getLedger(params)
      setEntries(data.entries)
      setTotal(data.total)
    } catch {}
  }

  async function verifyChain() {
    setVerifying(true)
    try {
      const result = await api.verifyHashChain(filters.tenantId || undefined)
      setHashResult(result)
    } catch {}
    setVerifying(false)
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin" className="text-slate-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold">Global Ledger Audit</h1>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl p-4 shadow-sm mb-4 flex flex-wrap gap-2">
        <input type="text" placeholder="Tenant ID" value={filters.tenantId} onChange={e => setFilters({ ...filters, tenantId: e.target.value })}
          className="px-3 py-2 rounded-lg border text-sm flex-1 min-w-[200px]" />
        <select value={filters.eventType} onChange={e => setFilters({ ...filters, eventType: e.target.value })}
          className="px-3 py-2 rounded-lg border text-sm">
          <option value="">All Events</option>
          <option value="INVOICE_CLAIMED">Invoice Claimed</option>
          <option value="REDEMPTION_PENDING">Redemption Pending</option>
          <option value="REDEMPTION_CONFIRMED">Redemption Confirmed</option>
          <option value="REDEMPTION_EXPIRED">Redemption Expired</option>
          <option value="REVERSAL">Reversal</option>
          <option value="ADJUSTMENT_MANUAL">Manual Adjustment</option>
        </select>
        <button onClick={loadLedger} className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm">Filter</button>
        <button onClick={verifyChain} disabled={verifying} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">
          {verifying ? 'Verifying...' : 'Verify Hash Chain'}
        </button>
      </div>

      {hashResult && (
        <div className={`rounded-xl p-4 mb-4 ${hashResult.allValid || hashResult.valid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {hashResult.allValid !== undefined
            ? (hashResult.allValid ? 'All tenant hash chains are valid' : 'Hash chain integrity issue detected!')
            : (hashResult.valid ? 'Hash chain is valid' : `Hash chain broken at entry: ${hashResult.brokenAt}`)}
        </div>
      )}

      <p className="text-sm text-slate-500 mb-2">Total entries: {total}</p>

      <div className="space-y-1">
        {entries.map((e: any) => (
          <div key={e.id} className="bg-white rounded-lg p-3 shadow-sm text-sm">
            <div className="flex justify-between">
              <span className="font-mono text-xs text-slate-400">{e.id.slice(0, 8)}...</span>
              <span className={`font-medium ${e.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                {e.entryType} {parseFloat(e.amount).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-slate-600">{e.eventType}</span>
              <span className="text-xs text-slate-400">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            {e.tenant && <span className="text-xs text-slate-400">{e.tenant.name}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
