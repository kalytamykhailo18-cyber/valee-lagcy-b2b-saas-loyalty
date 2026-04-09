'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

interface Settings {
  welcomeBonusAmount: number
  rif: string | null
  name: string
  preferredExchangeSource: string | null
  referenceCurrency: string
}

interface PlanUsage {
  plan: string
  usage: Record<string, { current: number; limit: number; percent: number }>
}

const ACTION_LABELS: Record<string, string> = {
  flash_offers: 'Ofertas flash este mes',
  whatsapp_messages: 'Mensajes de WhatsApp este mes',
  products_in_catalog: 'Productos en el catalogo',
  staff_members: 'Miembros del personal',
  csv_uploads: 'Cargas de CSV este mes',
}

interface Rate {
  source: string
  currency: string
  rateBs: number
  reportedAt: string
}

const SOURCE_LABELS: Record<string, string> = {
  bcv: 'BCV (Banco Central oficial)',
  binance_p2p: 'Binance P2P',
  bybit_p2p: 'Bybit P2P',
  promedio: 'Promedio (mercado paralelo)',
  euro_bcv: 'Euro BCV',
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [rates, setRates] = useState<Rate[]>([])
  const [planUsage, setPlanUsage] = useState<PlanUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [welcomeBonus, setWelcomeBonus] = useState('')
  const [rif, setRif] = useState('')
  const [exchangeSource, setExchangeSource] = useState('')
  const [refCurrency, setRefCurrency] = useState('usd')

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [s, r, pu] = await Promise.all([
        api.getMerchantSettings(),
        api.getExchangeRates(),
        api.getPlanUsage().catch(() => null),
      ])
      setSettings(s)
      setRates(r.rates)
      setPlanUsage(pu)
      setWelcomeBonus(String(s.welcomeBonusAmount))
      setRif(s.rif || '')
      setExchangeSource(s.preferredExchangeSource || '')
      setRefCurrency(s.referenceCurrency || 'usd')
    } catch (e: any) {
      setMessage('Error: ' + (e.error || 'no se pudo cargar'))
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setMessage('')
    try {
      const updated = await api.updateMerchantSettings({
        welcomeBonusAmount: Number(welcomeBonus),
        rif: rif.trim(),
        preferredExchangeSource: exchangeSource || null,
        referenceCurrency: refCurrency,
      })
      setSettings(updated)
      setMessage('Guardado')
      setTimeout(() => setMessage(''), 2500)
    } catch (e: any) {
      setMessage('Error: ' + (e.error || 'no se pudo guardar'))
    } finally {
      setSaving(false)
    }
  }

  const currentRate = rates.find(r => r.source === exchangeSource && r.currency === refCurrency)

  if (loading) return <div className="p-8 text-center text-slate-400">Cargando...</div>

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Configuracion</h1>
        <p className="text-sm text-slate-500 mt-1">Ajustes del comercio, tasa de cambio y plan</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {message && (
          <div className={`mb-4 p-3 rounded-xl text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left column */}
          <div className="space-y-6">
            {/* General */}
            <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
              <h2 className="font-semibold text-slate-800 text-lg mb-4">General</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Puntos de bienvenida</label>
                  <input type="number" value={welcomeBonus} onChange={e => setWelcomeBonus(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" min="0" />
                  <p className="text-xs text-slate-400 mt-1">Cuantos puntos recibe cada cliente nuevo. 0 desactiva.</p>
                </div>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">RIF del comercio</label>
                  <input type="text" value={rif} onChange={e => setRif(e.target.value)} placeholder="J-12345678-9"
                    className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>
            </section>

            {/* Exchange rate */}
            <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
              <h2 className="font-semibold text-slate-800 text-lg mb-1">Tasa de cambio</h2>
              <p className="text-xs text-slate-500 mb-4">
                Si tus facturas vienen en Bolivares, elige una fuente para normalizarlas a USD/EUR antes de calcular puntos.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Fuente de tasa</label>
                  <select value={exchangeSource} onChange={e => setExchangeSource(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    <option value="">Sin normalizacion (usar monto crudo)</option>
                    {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Moneda de referencia</label>
                  <select value={refCurrency} onChange={e => setRefCurrency(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    <option value="usd">USD</option>
                    <option value="eur">EUR</option>
                    <option value="bs">BS (sin conversion)</option>
                  </select>
                </div>

                {currentRate && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm">
                    <p className="text-emerald-700 font-semibold">
                      Tasa actual: 1 {currentRate.currency.toUpperCase()} = Bs {currentRate.rateBs.toFixed(2)}
                    </p>
                    <p className="text-xs text-emerald-600 mt-1">
                      Reportada: {new Date(currentRate.reportedAt).toLocaleString('es-VE')}
                    </p>
                  </div>
                )}
              </div>
            </section>

            <button onClick={save} disabled={saving}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-emerald-700 transition">
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {/* Plan & Usage */}
            {planUsage && (
              <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-slate-800 text-lg">Plan actual</h2>
                  <span className="text-xs uppercase tracking-wide bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full font-bold">
                    {planUsage.plan}
                  </span>
                </div>
                <div className="space-y-4">
                  {Object.entries(planUsage.usage).map(([key, u]) => (
                    <div key={key}>
                      <div className="flex justify-between text-sm text-slate-600 mb-1.5">
                        <span>{ACTION_LABELS[key] || key}</span>
                        <span className="font-semibold text-slate-800">{u.current.toLocaleString()} / {u.limit.toLocaleString()}</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            u.percent >= 90 ? 'bg-red-500' : u.percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(100, u.percent)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Available rates */}
            <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
              <h2 className="font-semibold text-slate-800 text-lg mb-4">Tasas disponibles</h2>
              {rates.length === 0 ? (
                <p className="text-sm text-slate-400">Aun no hay tasas en el sistema.</p>
              ) : (
                <div className="space-y-2">
                  {rates.map((r, i) => (
                    <div key={i} className="flex justify-between items-center py-2.5 border-b border-slate-100 last:border-0">
                      <div>
                        <p className="text-sm font-medium text-slate-700">{SOURCE_LABELS[r.source] || r.source}</p>
                        <p className="text-xs text-slate-400">{r.currency.toUpperCase()}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-slate-800">Bs {r.rateBs.toFixed(2)}</p>
                        <p className="text-xs text-slate-400">{new Date(r.reportedAt).toLocaleDateString('es-VE')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
