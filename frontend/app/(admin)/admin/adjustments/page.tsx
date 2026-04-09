'use client'

import { useState } from 'react'
import { api } from '@/lib/api'

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
      setResult({ success: false, error: e.error || 'Error al aplicar el ajuste' })
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Ajuste manual</h1>
        <p className="text-sm text-slate-500 mt-1">Aplica una correccion directa al ledger con motivo obligatorio</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="max-w-2xl">
          <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 space-y-5">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <p className="font-semibold mb-1">Accion irreversible</p>
              <p className="text-xs leading-relaxed">
                Cada ajuste crea una doble entrada en el ledger vinculada a tu cuenta de administrador.
                El motivo es obligatorio y queda registrado permanentemente.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Tenant ID</label>
                <input
                  type="text"
                  value={form.tenantId}
                  onChange={e => setForm({ ...form, tenantId: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Account ID</label>
                <input
                  type="text"
                  value={form.accountId}
                  onChange={e => setForm({ ...form, accountId: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Asset Type ID</label>
              <input
                type="text"
                value={form.assetTypeId}
                onChange={e => setForm({ ...form, assetTypeId: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion</label>
                <select
                  value={form.direction}
                  onChange={e => setForm({ ...form, direction: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="credit">Credit +</option>
                  <option value="debit">Debit -</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">
                Motivo <span className="text-red-500">*</span>
              </label>
              <textarea
                placeholder="Explica el motivo del ajuste (minimo 5 caracteres)"
                value={form.reason}
                onChange={e => setForm({ ...form, reason: e.target.value })}
                className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {result && (
              <div className={`text-sm p-3 rounded-xl border ${
                result.success
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-red-50 text-red-800 border-red-200'
              }`}>
                {result.success ? `Ajuste aplicado. Nuevo saldo: ${result.newBalance}` : result.error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || !form.accountId || !form.tenantId || !form.amount || form.reason.length < 5}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-indigo-700 transition"
            >
              {loading ? 'Aplicando...' : 'Aplicar ajuste'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
