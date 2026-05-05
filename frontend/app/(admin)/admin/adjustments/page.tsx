'use client'

import { useState } from 'react'
import { api } from '@/lib/api'

export default function ManualAdjustments() {
  const [form, setForm] = useState({ accountId: '', tenantId: '', amount: '', direction: 'credit', reason: '', assetTypeId: '' })
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [pressed, setPressed] = useState(false)

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

  const disabled = loading || !form.accountId || !form.tenantId || !form.amount || form.reason.length < 5

  return (
    <div className="min-h-screen bg-slate-50 overflow-hidden">
      <style jsx global>{`
        @keyframes aa-rise {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes aa-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes aa-pop {
          0% { opacity: 0; transform: translateY(-6px) scale(0.98); }
          60% { opacity: 1; transform: translateY(1px) scale(1.01); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes aa-shimmer {
          0% { background-position: -120% 0; }
          100% { background-position: 220% 0; }
        }
        @keyframes aa-ring-pulse {
          0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.35); }
          100% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
        }
        .aa-rise { animation: aa-rise 520ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .aa-pop { animation: aa-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
        .aa-field {
          transition: border-color 220ms ease, box-shadow 260ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms ease, background-color 220ms ease;
        }
        .aa-field:focus {
          border-color: rgb(99, 102, 241);
          box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
          transform: translateY(-1px);
          outline: none;
        }
        .aa-field:hover:not(:focus):not(:disabled) {
          border-color: rgb(199, 210, 254);
        }
        .aa-btn {
          position: relative;
          overflow: hidden;
          transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
                      box-shadow 260ms ease,
                      background-color 220ms ease,
                      opacity 220ms ease;
          box-shadow: 0 1px 2px rgba(67, 56, 202, 0.12), 0 6px 20px -8px rgba(67, 56, 202, 0.45);
        }
        .aa-btn:not(:disabled):hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 4px rgba(67, 56, 202, 0.18), 0 14px 32px -10px rgba(67, 56, 202, 0.55);
        }
        .aa-btn:not(:disabled):active {
          transform: translateY(0) scale(0.985);
        }
        .aa-btn::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%);
          background-size: 200% 100%;
          background-position: -120% 0;
          pointer-events: none;
          transition: opacity 200ms ease;
          opacity: 0;
        }
        .aa-btn:not(:disabled):hover::before {
          opacity: 1;
          animation: aa-shimmer 1.4s ease-in-out infinite;
        }
        .aa-btn:disabled {
          box-shadow: none;
        }
        .aa-warning {
          position: relative;
          overflow: hidden;
        }
        .aa-warning::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(110deg, transparent 40%, rgba(255,255,255,0.5) 50%, transparent 60%);
          background-size: 200% 100%;
          background-position: -120% 0;
          animation: aa-shimmer 3.6s ease-in-out infinite;
          pointer-events: none;
        }
        .aa-spinner {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35);
          border-top-color: white;
          animation: aa-spin 0.7s linear infinite;
        }
        @keyframes aa-spin { to { transform: rotate(360deg); } }
        .aa-pressed { animation: aa-ring-pulse 560ms ease-out; }
      `}</style>

      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise" style={{ animationDelay: '0ms' }}>
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Ajuste manual</h1>
        <p className="text-sm text-slate-500 mt-1">Aplica una correccion directa al ledger con motivo obligatorio</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        <div className="max-w-2xl">
          <div
            className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 space-y-5 aa-rise"
            style={{ animationDelay: '80ms' }}
          >
            <div className="aa-warning bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 aa-rise" style={{ animationDelay: '160ms' }}>
              <p className="font-semibold mb-1 relative z-10">Accion irreversible</p>
              <p className="text-xs leading-relaxed relative z-10">
                Cada ajuste crea una doble entrada en el ledger vinculada a tu cuenta de administrador.
                El motivo es obligatorio y queda registrado permanentemente.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 aa-rise" style={{ animationDelay: '220ms' }}>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Tenant ID</label>
                <input
                  type="text"
                  value={form.tenantId}
                  onChange={e => setForm({ ...form, tenantId: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Account ID</label>
                <input
                  type="text"
                  value={form.accountId}
                  onChange={e => setForm({ ...form, accountId: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono"
                />
              </div>
            </div>

            <div className="aa-rise" style={{ animationDelay: '280ms' }}>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Asset Type ID</label>
              <input
                type="text"
                value={form.assetTypeId}
                onChange={e => setForm({ ...form, assetTypeId: e.target.value })}
                className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 aa-rise" style={{ animationDelay: '340ms' }}>
              <div className="col-span-2">
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Monto</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion</label>
                <select
                  value={form.direction}
                  onChange={e => setForm({ ...form, direction: e.target.value })}
                  className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
                >
                  <option value="credit">Credit +</option>
                  <option value="debit">Debit -</option>
                </select>
              </div>
            </div>

            <div className="aa-rise" style={{ animationDelay: '400ms' }}>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">
                Motivo <span className="text-red-500">*</span>
              </label>
              <textarea
                placeholder="Explica el motivo del ajuste (minimo 5 caracteres)"
                value={form.reason}
                onChange={e => setForm({ ...form, reason: e.target.value })}
                className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-24 resize-none"
              />
              <div className="flex justify-end mt-1">
                <span className={`text-[11px] tabular-nums transition-colors duration-200 ${form.reason.length >= 5 ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {form.reason.length} / 5+
                </span>
              </div>
            </div>

            {result && (
              <div
                key={result.success ? 'ok' : 'err'}
                className={`aa-pop text-sm p-3 rounded-xl border ${
                  result.success
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-red-50 text-red-800 border-red-200'
                }`}
              >
                {result.success ? `Ajuste aplicado. Nuevo saldo: ${result.newBalance}` : result.error}
              </div>
            )}

            <button
              onClick={() => { setPressed(true); setTimeout(() => setPressed(false), 600); handleSubmit() }}
              disabled={disabled}
              className={`aa-btn ${pressed ? 'aa-pressed' : ''} w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-700 flex items-center justify-center gap-2 aa-rise`}
              style={{ animationDelay: '460ms' }}
            >
              {loading && <span className="aa-spinner" />}
              <span className="relative z-10">{loading ? 'Aplicando...' : 'Aplicar ajuste'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
