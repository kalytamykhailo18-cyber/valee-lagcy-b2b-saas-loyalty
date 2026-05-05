'use client'

import { useEffect, useState } from 'react'
import { MdShare, MdQrCode2, MdCheckCircle, MdPaid } from 'react-icons/md'
import { api } from '@/lib/api'

// Eric 2026-04-25: every points/cap field must reject decimal separators —
// "1.500" should mean fifteen hundred, never one-point-five.
const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

interface Summary {
  codesIssued: number
  codesScanned: number
  pending: number
  credited: number
  rejected: number
  bonusPaid: string
}

interface TopReferrer {
  accountId: string
  phoneNumber: string | null
  displayName: string | null
  referralSlug: string | null
  creditedCount: number
  bonusTotal: string
}

interface RecentRow {
  id: string
  status: 'pending' | 'credited' | 'rejected'
  bonusAmount: string | null
  createdAt: string
  creditedAt: string | null
  referrer: { phoneNumber: string | null; displayName: string | null }
  referee:  { phoneNumber: string | null; displayName: string | null }
}

interface MetricsResponse {
  summary: Summary
  topReferrers: TopReferrer[]
  recent: RecentRow[]
}

function fmtInt(n: number | string) {
  const x = typeof n === 'string' ? Number(n) : n
  return Math.round(x).toLocaleString()
}

function fmtPhone(p: string | null) {
  if (!p) return '—'
  if (p.length < 4) return p
  return `***${p.slice(-4)}`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' })
}

const STATUS_LABEL: Record<RecentRow['status'], string> = {
  pending: 'Pendiente',
  credited: 'Acreditado',
  rejected: 'Rechazado',
}
const STATUS_CLASS: Record<RecentRow['status'], string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  credited: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-slate-100 text-slate-600 border-slate-200',
}

export default function ReferralsPage() {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Owner-visible config: bonus amount is shared with /merchant/settings —
  // editing here saves to the same tenant field so both screens stay
  // consistent. Empty string until settings resolves.
  const [bonusDraft, setBonusDraft] = useState('')
  const [bonusSaved, setBonusSaved] = useState<number | null>(null)
  const [bonusMsg, setBonusMsg] = useState('')
  const [bonusSaving, setBonusSaving] = useState(false)
  const [activeDraft, setActiveDraft] = useState(true)
  const [limitDraft, setLimitDraft] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [res, s] = await Promise.all([
          api.getReferralMetrics(),
          api.getMerchantSettings().catch(() => null),
        ])
        if (cancelled) return
        setData(res)
        if (s && typeof (s as any).referralBonusAmount === 'number') {
          setBonusDraft(String((s as any).referralBonusAmount))
          setBonusSaved((s as any).referralBonusAmount)
          setActiveDraft((s as any).referralBonusActive !== false)
          setLimitDraft((s as any).referralBonusLimit != null ? String((s as any).referralBonusLimit) : '')
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'No se pudieron cargar las metricas')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function saveBonus() {
    const n = Number(bonusDraft)
    if (!Number.isFinite(n) || n < 0) {
      setBonusMsg('Debe ser un numero mayor o igual a 0')
      return
    }
    setBonusSaving(true)
    setBonusMsg('')
    try {
      await api.updateMerchantSettings({
        referralBonusAmount: n,
        referralBonusActive: activeDraft,
        referralBonusLimit: limitDraft.trim() ? Number(limitDraft) : null,
      })
      setBonusSaved(n)
      setBonusMsg('Guardado')
      setTimeout(() => setBonusMsg(''), 2500)
    } catch (e: any) {
      setBonusMsg('Error: ' + (e?.error || 'no se pudo guardar'))
    } finally {
      setBonusSaving(false)
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

  const { summary, topReferrers, recent } = data
  const convRate = summary.codesScanned > 0
    ? Math.round((summary.credited / summary.codesScanned) * 100)
    : 0

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Referidos</h1>
        <p className="text-sm text-slate-500 mt-1">
          Cuantos codigos se repartieron, cuantos se usaron y cuanto pagaste en bonos.
        </p>
      </header>

      <section className="bg-white border border-slate-200 rounded-xl p-4 mb-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Estado del programa</p>
            <p className="text-xs text-slate-500 mt-1">
              Cuando esta apagado o se llena el cupo, no se acreditan nuevos bonos por referido.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveDraft(!activeDraft)}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${activeDraft ? 'bg-emerald-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${activeDraft ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Puntos por referido</label>
            <input
              type="text"
              inputMode="numeric"
              value={fmtThousands(bonusDraft)}
              onChange={e => setBonusDraft(stripNonDigits(e.target.value))}
              disabled={!activeDraft}
              className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cupo (opcional)</label>
            <input
              type="text"
              inputMode="numeric"
              value={fmtThousands(limitDraft)}
              onChange={e => setLimitDraft(stripNonDigits(e.target.value))}
              disabled={!activeDraft}
              placeholder="Sin limite"
              className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
            <p className="text-xs text-slate-400 mt-1">Limite de bonos a entregar antes de pausar.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 justify-end">
          {bonusMsg && (
            <span className={`text-xs ${bonusMsg.startsWith('Error') ? 'text-rose-600' : 'text-emerald-600'}`}>
              {bonusMsg}
            </span>
          )}
          <button
            onClick={saveBonus}
            disabled={bonusSaving || bonusDraft === ''}
            className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-emerald-700"
          >
            {bonusSaving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card
          icon={<MdShare className="w-5 h-5" />}
          label="Codigos entregados"
          value={fmtInt(summary.codesIssued)}
          hint="Clientes con su QR personal"
          tone="indigo"
        />
        <Card
          icon={<MdQrCode2 className="w-5 h-5" />}
          label="Codigos escaneados"
          value={fmtInt(summary.codesScanned)}
          hint={`${summary.pending} pendientes`}
          tone="sky"
        />
        <Card
          icon={<MdCheckCircle className="w-5 h-5" />}
          label="Primera compra"
          value={fmtInt(summary.credited)}
          hint={`${convRate}% de conversion`}
          tone="emerald"
        />
        <Card
          icon={<MdPaid className="w-5 h-5" />}
          label="Puntos pagados"
          value={fmtInt(summary.bonusPaid)}
          hint="Total acreditado a referidores"
          tone="amber"
        />
      </section>

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">Top referidores</h2>
          <span className="text-xs text-slate-400">
            {topReferrers.length} {topReferrers.length === 1 ? 'persona' : 'personas'}
          </span>
        </div>
        {topReferrers.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 text-center">
            Todavia nadie completo un referido en este comercio.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {topReferrers.map((r, i) => (
              <li key={r.accountId} className="flex items-center gap-3 px-4 py-3">
                <span className="w-6 text-sm font-bold text-slate-400">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">
                    {r.displayName || fmtPhone(r.phoneNumber)}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {r.displayName ? fmtPhone(r.phoneNumber) : (r.referralSlug || '')}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-emerald-700">{r.creditedCount}</p>
                  <p className="text-xs text-slate-500">{fmtInt(r.bonusTotal)} pts</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-700">Actividad reciente</h2>
        </div>
        {recent.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 text-center">
            Aun no hay referidos registrados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Referidor</th>
                  <th className="text-left px-4 py-2 font-semibold">Invitado</th>
                  <th className="text-left px-4 py-2 font-semibold">Estado</th>
                  <th className="text-right px-4 py-2 font-semibold">Bono</th>
                  <th className="text-right px-4 py-2 font-semibold">Fecha</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map(r => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 text-slate-700">
                      {r.referrer.displayName || fmtPhone(r.referrer.phoneNumber)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.referee.displayName || fmtPhone(r.referee.phoneNumber)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs font-semibold border rounded-full px-2 py-0.5 ${STATUS_CLASS[r.status]}`}>
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {r.bonusAmount ? `${fmtInt(r.bonusAmount)} pts` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500 text-xs">
                      {fmtDate(r.creditedAt || r.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Card({
  icon, label, value, hint, tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
  tone: 'indigo' | 'sky' | 'emerald' | 'amber'
}) {
  const toneMap = {
    indigo:  'bg-indigo-50  text-indigo-700  ring-indigo-100',
    sky:     'bg-sky-50     text-sky-700     ring-sky-100',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    amber:   'bg-amber-50   text-amber-700   ring-amber-100',
  }[tone]
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className={`inline-flex items-center gap-2 ${toneMap} ring-1 rounded-full px-2 py-1 text-xs font-semibold mb-2`}>
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-2xl font-extrabold text-slate-900 leading-tight">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{hint}</p>
    </div>
  )
}
