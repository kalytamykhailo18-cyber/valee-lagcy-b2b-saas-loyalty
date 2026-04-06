'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Dispute {
  id: string
  description: string
  screenshotUrl: string | null
  status: string
  consumerPhone: string | null
  consumerAccountId: string
  resolutionReason: string | null
  createdAt: string
  resolvedAt: string | null
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  escalated: 'Escalada',
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  escalated: 'bg-blue-100 text-blue-700',
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [resolveForm, setResolveForm] = useState<{ action: string; reason: string; adjustmentAmount: string }>({ action: '', reason: '', adjustmentAmount: '' })
  const [resolving, setResolving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => { loadDisputes() }, [statusFilter])

  async function loadDisputes() {
    setLoading(true)
    try {
      const data = await api.getDisputes(statusFilter || undefined)
      setDisputes(data.disputes)
    } catch {} finally { setLoading(false) }
  }

  async function handleResolve(disputeId: string) {
    if (!resolveForm.action || !resolveForm.reason.trim()) return
    setResolving(true)
    setMessage('')
    try {
      const result = await api.resolveDispute(disputeId, {
        action: resolveForm.action,
        reason: resolveForm.reason.trim(),
        adjustmentAmount: resolveForm.action === 'approve' && resolveForm.adjustmentAmount ? resolveForm.adjustmentAmount : undefined,
      })
      setMessage(result.message || 'Disputa resuelta')
      setExpandedId(null)
      setResolveForm({ action: '', reason: '', adjustmentAmount: '' })
      loadDisputes()
    } catch (e: any) {
      setMessage(e.error || 'Error al resolver disputa')
    }
    setResolving(false)
  }

  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold text-emerald-800">Disputas</h1>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {['', 'open', 'escalated', 'approved', 'rejected'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap ${
              statusFilter === s ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 shadow-sm'
            }`}>
            {s ? STATUS_LABELS[s] || s : 'Todas'}
          </button>
        ))}
      </div>

      {message && (
        <div className="mb-4 bg-white rounded-xl p-3 shadow-sm text-sm text-emerald-700">{message}</div>
      )}

      {loading ? (
        <p className="text-center text-slate-400 mt-8">Cargando...</p>
      ) : disputes.length === 0 ? (
        <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
          <span className="text-4xl">📋</span>
          <p className="text-slate-500 mt-3">No hay disputas {statusFilter ? STATUS_LABELS[statusFilter]?.toLowerCase() + 's' : 'pendientes'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map(d => (
            <div key={d.id} className="bg-white rounded-xl p-4 shadow-sm">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div className="flex-1 cursor-pointer" onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}>
                  <p className="font-medium text-sm">{d.description.length > 80 ? d.description.slice(0, 80) + '...' : d.description}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {d.consumerPhone || 'Sin telefono'} | {new Date(d.createdAt).toLocaleString('es-VE')}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ml-2 flex-shrink-0 ${STATUS_STYLES[d.status] || 'bg-slate-100 text-slate-600'}`}>
                  {STATUS_LABELS[d.status] || d.status}
                </span>
              </div>

              {/* Expanded Details */}
              {expandedId === d.id && (
                <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
                  <div>
                    <p className="text-xs text-slate-500 font-medium">Descripcion completa:</p>
                    <p className="text-sm text-slate-700 mt-1">{d.description}</p>
                  </div>

                  {d.screenshotUrl && (
                    <div>
                      <p className="text-xs text-slate-500 font-medium mb-1">Captura adjunta:</p>
                      <img src={d.screenshotUrl} alt="Evidencia" className="w-full max-w-xs rounded-lg border border-slate-200" />
                    </div>
                  )}

                  {d.resolutionReason && (
                    <div>
                      <p className="text-xs text-slate-500 font-medium">Razon de resolucion:</p>
                      <p className="text-sm text-slate-700 mt-1">{d.resolutionReason}</p>
                    </div>
                  )}

                  {/* Resolve Actions (only for open/escalated) */}
                  {(d.status === 'open' || d.status === 'escalated') && (
                    <div className="space-y-3 pt-2">
                      <p className="text-xs text-slate-500 font-medium">Resolver disputa:</p>

                      {/* Action buttons */}
                      <div className="flex gap-2">
                        <button onClick={() => setResolveForm({ ...resolveForm, action: 'approve' })}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                            resolveForm.action === 'approve' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-700'
                          }`}>
                          Aprobar
                        </button>
                        <button onClick={() => setResolveForm({ ...resolveForm, action: 'reject' })}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                            resolveForm.action === 'reject' ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700'
                          }`}>
                          Rechazar
                        </button>
                        <button onClick={() => setResolveForm({ ...resolveForm, action: 'escalate' })}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                            resolveForm.action === 'escalate' ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700'
                          }`}>
                          Escalar
                        </button>
                      </div>

                      {/* Adjustment amount (for approve) */}
                      {resolveForm.action === 'approve' && (
                        <div>
                          <label className="text-xs text-slate-500">Monto de ajuste (puntos)</label>
                          <input type="number" step="0.01" min="0" placeholder="0.00" value={resolveForm.adjustmentAmount}
                            onChange={e => setResolveForm({ ...resolveForm, adjustmentAmount: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm mt-1" />
                        </div>
                      )}

                      {/* Reason field */}
                      {resolveForm.action && (
                        <>
                          <div>
                            <label className="text-xs text-slate-500">Razon (obligatorio)</label>
                            <textarea value={resolveForm.reason}
                              onChange={e => setResolveForm({ ...resolveForm, reason: e.target.value })}
                              placeholder="Explica la decision..."
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm mt-1 h-20 resize-none" />
                          </div>
                          <button onClick={() => handleResolve(d.id)}
                            disabled={resolving || !resolveForm.reason.trim()}
                            className="w-full bg-emerald-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                            {resolving ? 'Procesando...' : 'Confirmar'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
