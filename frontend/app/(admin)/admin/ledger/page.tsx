'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

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
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Ledger global</h1>
        <p className="text-sm text-slate-500 mt-1">Auditoria cross-tenant de todas las transacciones financieras</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Filters */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 mb-6">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Filtros</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <input
              type="text"
              placeholder="Tenant ID"
              value={filters.tenantId}
              onChange={e => setFilters({ ...filters, tenantId: e.target.value })}
              className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <select
              value={filters.eventType}
              onChange={e => setFilters({ ...filters, eventType: e.target.value })}
              className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Todos los eventos</option>
              <option value="INVOICE_CLAIMED">INVOICE_CLAIMED</option>
              <option value="REDEMPTION_PENDING">REDEMPTION_PENDING</option>
              <option value="REDEMPTION_CONFIRMED">REDEMPTION_CONFIRMED</option>
              <option value="REDEMPTION_EXPIRED">REDEMPTION_EXPIRED</option>
              <option value="REVERSAL">REVERSAL</option>
              <option value="ADJUSTMENT_MANUAL">ADJUSTMENT_MANUAL</option>
            </select>
            <button
              onClick={loadLedger}
              className="bg-indigo-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition"
            >
              Filtrar
            </button>
            <button
              onClick={verifyChain}
              disabled={verifying}
              className="bg-slate-800 text-white px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-slate-900 transition"
            >
              {verifying ? 'Verificando...' : 'Verificar hash chain'}
            </button>
          </div>
        </div>

        {hashResult && (
          <div className={`rounded-2xl p-4 mb-6 border ${
            hashResult.allValid || hashResult.valid
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}>
            {hashResult.allValid !== undefined
              ? (hashResult.allValid ? 'Todas las cadenas hash son validas' : 'Problema de integridad en el hash chain detectado')
              : (hashResult.valid ? 'El hash chain es valido' : `Hash chain roto en entry: ${hashResult.brokenAt}`)}
          </div>
        )}

        <p className="text-sm text-slate-500 mb-4">Total entradas: <span className="font-semibold text-slate-800">{total}</span></p>

        {/* Entries table */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="divide-y divide-slate-100">
            {entries.length === 0 ? (
              <p className="p-8 text-center text-slate-400">No hay entradas con esos filtros</p>
            ) : (
              entries.map((e: any) => (
                <div key={e.id} className="p-4 hover:bg-slate-50 transition">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-mono text-xs text-slate-400">{e.id.slice(0, 8)}</span>
                        <span className="text-sm font-semibold text-slate-800">{e.eventType}</span>
                        {e.tenant && <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">{e.tenant.name}</span>}
                      </div>
                      <p className="text-xs text-slate-500">{new Date(e.createdAt).toLocaleString('es-VE')}</p>
                    </div>
                    <span className={`font-bold text-lg flex-shrink-0 ${e.entryType === 'CREDIT' ? 'text-emerald-600' : 'text-red-500'}`}>
                      {e.entryType === 'CREDIT' ? '+' : '-'}{parseFloat(e.amount).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
