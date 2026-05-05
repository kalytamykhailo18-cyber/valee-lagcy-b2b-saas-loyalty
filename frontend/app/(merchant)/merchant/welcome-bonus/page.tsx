'use client'

import { useEffect, useState } from 'react'
import { MdStars, MdPaid, MdInventory2, MdHourglassEmpty } from 'react-icons/md'
import { api } from '@/lib/api'

interface MetricsResponse {
  config: {
    amount: number
    active: boolean
    limit: number | null
  }
  summary: {
    granted: number
    totalPaid: string
    limit: number | null
    remaining: number | null
    capReached: boolean
  }
  recent: Array<{
    id: string
    amount: string
    createdAt: string
    consumer: { phoneNumber: string | null; displayName: string | null }
    branchName: string | null
  }>
}

const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

function fmtInt(n: number | string) {
  const x = typeof n === 'string' ? Number(n) : n
  return Math.round(x).toLocaleString('es-VE')
}
function fmtPhone(p: string | null) {
  if (!p) return '—'
  if (p.length < 4) return p
  return `***${p.slice(-4)}`
}
function fmtDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function WelcomeBonusPage() {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [amountDraft, setAmountDraft] = useState('')
  const [limitDraft, setLimitDraft] = useState('')
  const [activeDraft, setActiveDraft] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const res: any = await api.getWelcomeBonusMetrics()
      setData(res)
      setAmountDraft(String(res.config.amount))
      setActiveDraft(res.config.active !== false)
      setLimitDraft(res.config.limit != null ? String(res.config.limit) : '')
    } catch (e: any) {
      setError(e?.error || 'No se pudieron cargar las metricas')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function saveConfig() {
    setSaving(true)
    setMsg('')
    try {
      await api.updateMerchantSettings({
        welcomeBonusAmount: Number(amountDraft || 0),
        welcomeBonusActive: activeDraft,
        welcomeBonusLimit: limitDraft.trim() ? Number(limitDraft) : null,
      })
      setMsg('Guardado')
      await load()
      setTimeout(() => setMsg(''), 2500)
    } catch (e: any) {
      setMsg('Error: ' + (e?.error || 'no se pudo guardar'))
    } finally {
      setSaving(false)
    }
  }

  // Eric 2026-05-04 (Notion "Configuracion de puntos de bienvenida y de
  // referidos"): merchants flipped the ON/OFF expecting it to save and
  // walked away without clicking Guardar. Auto-save the toggle on click,
  // keeping the Guardar button only for the puntos + cupo fields.
  async function toggleActiveAutoSave(next: boolean) {
    const prev = activeDraft
    setActiveDraft(next)
    setSaving(true)
    setMsg('')
    try {
      await api.updateMerchantSettings({ welcomeBonusActive: next })
      setMsg(next ? 'Bono activado' : 'Bono desactivado')
      setTimeout(() => setMsg(''), 2500)
    } catch (e: any) {
      setActiveDraft(prev) // revert on failure
      setMsg('Error: ' + (e?.error || 'no se pudo guardar'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
          {error || 'Sin datos'}
        </div>
      </div>
    )
  }

  const { summary, recent } = data

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Bono de bienvenida</h1>
        <p className="text-sm text-slate-500 mt-1">
          Cuantos clientes nuevos lo recibieron, cuanto pagaste y control de la campaña.
        </p>
      </header>

      {/* Config card with on/off + amount + limit */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 mb-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Estado del bono</p>
            <p className="text-xs text-slate-500 mt-1">
              Cuando esta apagado o se llena el cupo, el bot deja de mencionarlo en el saludo.
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleActiveAutoSave(!activeDraft)}
            disabled={saving}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${activeDraft ? 'bg-emerald-600' : 'bg-slate-300'} disabled:opacity-50`}
            aria-label="Activar/desactivar bono de bienvenida"
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${activeDraft ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Puntos por cliente nuevo</label>
            <input
              type="text" inputMode="numeric"
              value={fmtThousands(amountDraft)}
              onChange={e => setAmountDraft(stripNonDigits(e.target.value))}
              disabled={!activeDraft}
              className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cupo (opcional)</label>
            <input
              type="text" inputMode="numeric"
              value={fmtThousands(limitDraft)}
              onChange={e => setLimitDraft(stripNonDigits(e.target.value))}
              disabled={!activeDraft}
              placeholder="Sin limite"
              className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
            <p className="text-xs text-slate-400 mt-1">Limite total a entregar (ej: solo 20 primeros). Vacio = sin limite.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 justify-end">
          {msg && <span className={`text-xs ${msg.startsWith('Error') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</span>}
          <button
            onClick={saveConfig}
            disabled={saving}
            className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700"
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </section>

      {/* Summary cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold">
            <MdStars className="w-4 h-4 text-emerald-600" /> Bonos entregados
          </div>
          <p className="text-2xl font-bold text-slate-800 mt-2 tabular-nums">{fmtInt(summary.granted)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold">
            <MdPaid className="w-4 h-4 text-amber-600" /> Puntos pagados
          </div>
          <p className="text-2xl font-bold text-slate-800 mt-2 tabular-nums">{fmtInt(summary.totalPaid)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold">
            <MdInventory2 className="w-4 h-4 text-indigo-600" /> Cupo
          </div>
          <p className="text-2xl font-bold text-slate-800 mt-2 tabular-nums">
            {summary.limit != null ? fmtInt(summary.limit) : 'Sin limite'}
          </p>
        </div>
        <div className={`bg-white border rounded-xl p-4 ${summary.capReached ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}>
          <div className="flex items-center gap-2 text-xs font-semibold ${summary.capReached ? 'text-red-700' : 'text-slate-500'}">
            <MdHourglassEmpty className={`w-4 h-4 ${summary.capReached ? 'text-red-600' : 'text-slate-400'}`} /> Restante
          </div>
          <p className={`text-2xl font-bold mt-2 tabular-nums ${summary.capReached ? 'text-red-700' : 'text-slate-800'}`}>
            {summary.remaining != null ? fmtInt(summary.remaining) : '—'}
          </p>
          {summary.capReached && (
            <p className="text-xs text-red-700 mt-1">Cupo lleno, ya no se entregan mas.</p>
          )}
        </div>
      </section>

      {/* Recent activity */}
      <section className="bg-white border border-slate-200 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-800">Actividad reciente</h2>
        </div>
        {recent.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-400">
            Aun no se han entregado bonos de bienvenida.
          </p>
        ) : (
          // Eric 2026-05-04 (Notion "Panel Clientes" PRIORIDAD 1): show
          // the full phone + WhatsApp display name. The previous masked
          // "***3100" hid identity from the merchant — they need to
          // know exactly who received the bono.
          <div className="divide-y divide-slate-100">
            {recent.map(r => (
              <div key={r.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {r.consumer.displayName ? (
                    <>
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {r.consumer.displayName}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {r.consumer.phoneNumber || '—'}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {r.consumer.phoneNumber || '—'}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 mt-0.5">
                    <span>{fmtDate(r.createdAt)}</span>
                    {r.branchName && <span>{r.branchName}</span>}
                  </div>
                </div>
                <span className="text-sm font-bold text-emerald-700 tabular-nums">+{fmtInt(r.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
