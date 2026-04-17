'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { formatPoints } from '@/lib/format'

export default function LedgerAudit() {
  const [entries, setEntries] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState({ tenantId: '', eventType: '', limit: '50', offset: '0' })
  const [hashResult, setHashResult] = useState<any>(null)
  const [verifying, setVerifying] = useState(false)
  const [tenants, setTenants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [listKey, setListKey] = useState(0)

  useEffect(() => {
    loadLedger()
    api.getTenants().then(d => setTenants(d.tenants || [])).catch(() => {})
  }, [])

  async function loadLedger() {
    setLoading(true)
    try {
      const params: Record<string, string> = {}
      if (filters.tenantId) params.tenantId = filters.tenantId
      if (filters.eventType) params.eventType = filters.eventType
      params.limit = filters.limit
      params.offset = filters.offset

      const data = await api.getLedger(params)
      setEntries(data.entries)
      setTotal(data.total)
      setListKey(k => k + 1)
    } catch {}
    setLoading(false)
  }

  async function verifyChain() {
    setVerifying(true)
    setHashResult(null)
    try {
      const result = await api.verifyHashChain(filters.tenantId || undefined)
      setHashResult(result)
    } catch {}
    setVerifying(false)
  }

  const hashOk = hashResult && (hashResult.allValid || hashResult.valid)

  return (
    <div className="min-h-screen bg-slate-50 overflow-hidden">
      <style jsx global>{`
        @keyframes al-rise {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes al-row {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes al-pop {
          0% { opacity: 0; transform: translateY(-6px) scale(0.98); }
          60% { opacity: 1; transform: translateY(1px) scale(1.01); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes al-shimmer {
          0% { background-position: -120% 0; }
          100% { background-position: 220% 0; }
        }
        @keyframes al-spin { to { transform: rotate(360deg); } }
        @keyframes al-skel {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes al-count {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .al-rise { animation: al-rise 560ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .al-pop { animation: al-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
        .al-count { animation: al-count 400ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .al-row-in {
          animation: al-row 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .al-field {
          transition: border-color 220ms ease, box-shadow 260ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms ease;
        }
        .al-field:focus {
          border-color: rgb(99, 102, 241);
          box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
          transform: translateY(-1px);
          outline: none;
        }
        .al-field:hover:not(:focus) {
          border-color: rgb(199, 210, 254);
        }
        .al-btn {
          position: relative;
          overflow: hidden;
          transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
                      box-shadow 260ms ease,
                      background-color 220ms ease,
                      opacity 220ms ease;
        }
        .al-btn-primary { box-shadow: 0 1px 2px rgba(67, 56, 202, 0.12), 0 6px 20px -8px rgba(67, 56, 202, 0.45); }
        .al-btn-dark    { box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12), 0 6px 20px -8px rgba(15, 23, 42, 0.55); }
        .al-btn:not(:disabled):hover { transform: translateY(-1px); }
        .al-btn-primary:not(:disabled):hover { box-shadow: 0 2px 4px rgba(67, 56, 202, 0.18), 0 14px 32px -10px rgba(67, 56, 202, 0.6); }
        .al-btn-dark:not(:disabled):hover    { box-shadow: 0 2px 4px rgba(15, 23, 42, 0.2),  0 14px 32px -10px rgba(15, 23, 42, 0.65); }
        .al-btn:not(:disabled):active { transform: translateY(0) scale(0.985); }
        .al-btn::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.3) 50%, transparent 70%);
          background-size: 200% 100%;
          background-position: -120% 0;
          pointer-events: none;
          opacity: 0;
          transition: opacity 200ms ease;
        }
        .al-btn:not(:disabled):hover::before {
          opacity: 1;
          animation: al-shimmer 1.4s ease-in-out infinite;
        }
        .al-spinner {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: white;
          animation: al-spin 0.7s linear infinite;
          display: inline-block;
          vertical-align: -2px;
          margin-right: 6px;
        }
        .al-skel {
          background: linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%);
          background-size: 200% 100%;
          animation: al-skel 1.3s ease-in-out infinite;
          border-radius: 8px;
        }
        .al-row {
          transition: background-color 220ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease;
        }
        .al-row:hover {
          background-color: rgb(248, 250, 252);
          transform: translateX(2px);
        }
        .al-chip {
          transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), background-color 220ms ease;
        }
        .al-row:hover .al-chip {
          transform: scale(1.04);
        }
        .al-amount {
          transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .al-row:hover .al-amount {
          transform: scale(1.06);
        }
      `}</style>

      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 al-rise" style={{ animationDelay: '0ms' }}>
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Ledger global</h1>
        <p className="text-sm text-slate-500 mt-1">Auditoria cross-tenant de todas las transacciones financieras</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Filters */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 mb-6 al-rise" style={{ animationDelay: '80ms' }}>
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Filtros</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <select
              value={filters.tenantId}
              onChange={e => setFilters({ ...filters, tenantId: e.target.value })}
              className="al-field px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
            >
              <option value="">Todos los comercios</option>
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select
              value={filters.eventType}
              onChange={e => setFilters({ ...filters, eventType: e.target.value })}
              className="al-field px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
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
              disabled={loading}
              className="al-btn al-btn-primary bg-indigo-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-60 hover:bg-indigo-700"
            >
              {loading && <span className="al-spinner" />}<span className="relative z-10">{loading ? 'Filtrando...' : 'Filtrar'}</span>
            </button>
            <button
              onClick={verifyChain}
              disabled={verifying}
              className="al-btn al-btn-dark bg-slate-800 text-white px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-60 hover:bg-slate-900"
            >
              {verifying && <span className="al-spinner" />}<span className="relative z-10">{verifying ? 'Verificando...' : 'Verificar hash chain'}</span>
            </button>
          </div>
        </div>

        {hashResult && (
          <div
            key={hashOk ? 'ok' : 'err'}
            className={`al-pop rounded-2xl p-4 mb-6 border flex items-center gap-3 ${
              hashOk
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-red-50 text-red-800 border-red-200'
            }`}
          >
            <span className={`inline-flex w-2.5 h-2.5 rounded-full ${hashOk ? 'bg-emerald-500' : 'bg-red-500'} animate-pulse`} />
            <span className="text-sm font-medium">
              {hashResult.allValid !== undefined
                ? (hashResult.allValid ? 'Todas las cadenas hash son validas' : 'Problema de integridad en el hash chain detectado')
                : (hashResult.valid ? 'El hash chain es valido' : `Hash chain roto en entry: ${hashResult.brokenAt}`)}
            </span>
          </div>
        )}

        <p className="text-sm text-slate-500 mb-4 al-rise" style={{ animationDelay: '160ms' }}>
          Total entradas: <span key={total} className="font-semibold text-slate-800 tabular-nums al-count inline-block">{total}</span>
        </p>

        {/* Entries table */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden al-rise" style={{ animationDelay: '220ms' }}>
          <div className="divide-y divide-slate-100">
            {loading && entries.length === 0 ? (
              <>
                {[0,1,2,3,4].map(i => (
                  <div key={i} className="p-4 flex items-center justify-between gap-3">
                    <div className="flex-1 space-y-2">
                      <div className="al-skel h-3 w-1/3" style={{ animationDelay: `${i*60}ms` }} />
                      <div className="al-skel h-2 w-1/5" style={{ animationDelay: `${i*60+40}ms` }} />
                    </div>
                    <div className="al-skel h-4 w-16" />
                  </div>
                ))}
              </>
            ) : entries.length === 0 ? (
              <p className="p-8 text-center text-slate-400">No hay entradas con esos filtros</p>
            ) : (
              entries.map((e: any, i: number) => (
                <div
                  key={`${listKey}-${e.id}`}
                  className="al-row al-row-in p-4"
                  style={{ animationDelay: `${Math.min(i * 22, 420)}ms` }}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-mono text-xs text-slate-400">{e.id.slice(0, 8)}</span>
                        <span className="text-sm font-semibold text-slate-800">{e.eventType}</span>
                        {e.tenant && (
                          <span className="al-chip text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                            {e.tenant.name}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">{new Date(e.createdAt).toLocaleString('es-VE')}</p>
                    </div>
                    <span className={`al-amount font-bold text-lg flex-shrink-0 tabular-nums ${e.entryType === 'CREDIT' ? 'text-emerald-600' : 'text-red-500'}`}>
                      {e.entryType === 'CREDIT' ? '+' : '-'}{formatPoints(e.amount)}
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
