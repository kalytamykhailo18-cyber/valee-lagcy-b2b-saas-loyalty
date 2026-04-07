'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

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

  if (loading) return <div className="p-4 text-center text-slate-400">Cargando...</div>

  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/merchant" className="text-emerald-700 text-2xl">←</Link>
        <h1 className="text-xl font-bold text-emerald-800">Configuracion</h1>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${message.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
          {message}
        </div>
      )}

      <div className="space-y-6">
        {/* Plan & Usage */}
        {planUsage && (
          <section className="bg-white rounded-2xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-800">Plan</h2>
              <span className="text-xs uppercase tracking-wide bg-indigo-100 text-indigo-700 px-2 py-1 rounded-full font-bold">
                {planUsage.plan}
              </span>
            </div>
            <div className="space-y-3">
              {Object.entries(planUsage.usage).map(([key, u]) => (
                <div key={key}>
                  <div className="flex justify-between text-xs text-slate-600 mb-1">
                    <span>{ACTION_LABELS[key] || key}</span>
                    <span className="font-medium">{u.current.toLocaleString()} / {u.limit.toLocaleString()}</span>
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

        {/* General */}
        <section className="bg-white rounded-2xl p-4 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-3">General</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-500">Puntos de bienvenida</label>
              <input type="number" value={welcomeBonus} onChange={e => setWelcomeBonus(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm" min="0" />
              <p className="text-xs text-slate-400 mt-1">Cuantos puntos recibe cada cliente nuevo. 0 desactiva.</p>
            </div>
            <div>
              <label className="text-xs text-slate-500">RIF del comercio</label>
              <input type="text" value={rif} onChange={e => setRif(e.target.value)} placeholder="J-12345678-9"
                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm" />
            </div>
          </div>
        </section>

        {/* Exchange rate */}
        <section className="bg-white rounded-2xl p-4 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-1">Tasa de cambio</h2>
          <p className="text-xs text-slate-500 mb-3">
            Si tus facturas vienen en Bolivares, elige una fuente para normalizarlas a USD/EUR antes de calcular puntos.
            Sin fuente seleccionada, los puntos se calculan sobre el monto crudo de la factura.
          </p>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-500">Fuente de tasa</label>
              <select value={exchangeSource} onChange={e => setExchangeSource(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white">
                <option value="">Sin normalizacion (usar monto crudo)</option>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Moneda de referencia</label>
              <select value={refCurrency} onChange={e => setRefCurrency(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white">
                <option value="usd">USD</option>
                <option value="eur">EUR</option>
                <option value="bs">BS (sin conversion)</option>
              </select>
            </div>

            {currentRate && (
              <div className="bg-emerald-50 rounded-lg p-3 text-sm">
                <p className="text-emerald-700 font-medium">
                  Tasa actual: 1 {currentRate.currency.toUpperCase()} = Bs {currentRate.rateBs.toFixed(2)}
                </p>
                <p className="text-xs text-emerald-600 mt-1">
                  Reportada: {new Date(currentRate.reportedAt).toLocaleString('es-VE')}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Available rates table */}
        <section className="bg-white rounded-2xl p-4 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-3">Tasas disponibles</h2>
          {rates.length === 0 ? (
            <p className="text-sm text-slate-400">Aun no hay tasas en el sistema.</p>
          ) : (
            <div className="space-y-2">
              {rates.map((r, i) => (
                <div key={i} className="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
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

        <button onClick={save} disabled={saving}
          className="w-full bg-emerald-600 text-white py-3 rounded-xl font-medium disabled:opacity-50">
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>
      </div>
    </div>
  )
}
