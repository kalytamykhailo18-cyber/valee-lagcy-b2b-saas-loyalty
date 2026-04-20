'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MdArrowBack, MdRefresh } from 'react-icons/md'
import { api } from '@/lib/api'

interface Entry {
  id: string
  tenantId: string | null
  tenantName: string | null
  actorType: string
  actorRole: string
  actorId: string
  actionType: string
  consumerAccountId: string | null
  consumerPhone: string | null
  outcome: string
  amount: string | null
  metadata: any
  createdAt: string
}

interface Response {
  total: number
  limit: number
  offset: number
  entries: Entry[]
}

const ACTION_TYPES = [
  { label: 'Todos', value: '' },
  { label: 'Sesion terminada', value: 'SESSION_TERMINATED' },
  { label: 'Ajuste manual', value: 'MANUAL_ADJUSTMENT' },
  { label: 'Comercio desactivado', value: 'TENANT_DEACTIVATED' },
  { label: 'Comercio creado', value: 'TENANT_CREATED' },
  { label: 'Staff creado', value: 'STAFF_CREATED' },
  { label: 'Staff desactivado', value: 'STAFF_DEACTIVATED' },
  { label: 'Canje QR exitoso', value: 'QR_SCAN_SUCCESS' },
  { label: 'Canje QR fallo', value: 'QR_SCAN_FAILURE' },
  { label: 'Cedula vinculada', value: 'IDENTITY_UPGRADE' },
  { label: 'Busqueda cliente', value: 'CUSTOMER_LOOKUP' },
  { label: 'CSV subido', value: 'CSV_UPLOAD' },
  { label: 'Producto creado', value: 'PRODUCT_CREATED' },
  { label: 'Producto editado', value: 'PRODUCT_UPDATED' },
  { label: 'Disputa aprobada', value: 'DISPUTE_APPROVED' },
  { label: 'Disputa rechazada', value: 'DISPUTE_REJECTED' },
  { label: 'Sucursal creada', value: 'BRANCH_CREATED' },
]

const PAGE_SIZE = 50

export default function AdminAuditPage() {
  const router = useRouter()
  const [data, setData] = useState<Response | null>(null)
  const [actionType, setActionType] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await api.getAuditLog({
        tenantId: tenantId.trim() || undefined,
        actionType: actionType || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }) as Response
      setData(d)
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) { router.push('/admin/login'); return }
      setError(e?.error || 'No se pudo cargar el audit log')
    } finally {
      setLoading(false)
    }
  }, [tenantId, actionType, page, router])

  useEffect(() => {
    const token = localStorage.getItem('adminAccessToken') || localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) { router.push('/admin/login'); return }
    load()
  }, [load, router])

  // Reset to first page when filters change
  useEffect(() => { setPage(0) }, [actionType, tenantId])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin" className="text-slate-500 hover:text-slate-700">
            <MdArrowBack className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Audit log</h1>
        </div>
        <p className="text-sm text-slate-500">Historial inmutable de acciones admin y staff. No se puede editar ni borrar.</p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-16 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={actionType}
            onChange={e => setActionType(e.target.value)}
            className="aa-field px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white"
          >
            {ACTION_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <input
            type="text"
            value={tenantId}
            onChange={e => setTenantId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            placeholder="Filtrar por tenantId (opcional)"
            className="aa-field px-3 py-2 rounded-xl border border-slate-200 text-sm w-72"
          />
          <button
            onClick={load}
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            disabled={loading}
          >
            <MdRefresh className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Aplicar
          </button>
          {data && (
            <span className="text-xs text-slate-500 ml-auto">
              {data.total.toLocaleString()} eventos &middot; pagina {page + 1} de {totalPages}
            </span>
          )}
        </div>

        {error && (
          <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-16">
            <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {data && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Fecha</th>
                  <th className="text-left px-3 py-2 font-semibold">Accion</th>
                  <th className="text-left px-3 py-2 font-semibold">Comercio</th>
                  <th className="text-left px-3 py-2 font-semibold">Actor</th>
                  <th className="text-left px-3 py-2 font-semibold">Afectado</th>
                  <th className="text-left px-3 py-2 font-semibold">Monto</th>
                  <th className="text-left px-3 py-2 font-semibold">Resultado</th>
                  <th className="text-left px-3 py-2 font-semibold">Detalles</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Sin eventos para estos filtros.</td></tr>
                ) : data.entries.map(e => {
                  const meta = e.metadata as any
                  const detail = meta?.reason || meta?.tenantName || meta?.productName || meta?.staffEmail
                    || (meta ? Object.entries(meta).slice(0, 3).map(([k,v]) => `${k}=${v}`).join(' ') : '')
                  return (
                    <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600 tabular-nums">
                        {new Date(e.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded font-mono text-[10px] ${
                          e.actionType.includes('DEACTIVATED') || e.actionType.includes('TERMINATED') || e.actionType.includes('FAILURE')
                            ? 'bg-red-100 text-red-800'
                            : e.actionType.includes('ADJUSTMENT') || e.actionType.includes('UPGRADE')
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-800'
                        }`}>
                          {e.actionType}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{e.tenantName || <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2 text-slate-600">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          e.actorType === 'admin' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'
                        }`}>
                          {e.actorRole}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600 font-mono text-[11px]">
                        {e.consumerPhone || (e.consumerAccountId ? e.consumerAccountId.slice(0, 8) : '—')}
                      </td>
                      <td className="px-3 py-2 text-slate-700 tabular-nums">
                        {e.amount ? Number(e.amount).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          e.outcome === 'success' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {e.outcome}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600 max-w-md truncate" title={String(detail || '')}>
                        {detail || <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="text-xs text-slate-500">
              {page * PAGE_SIZE + 1} – {Math.min((page + 1) * PAGE_SIZE, data.total)} de {data.total.toLocaleString()}
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) >= totalPages || loading}
              className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
