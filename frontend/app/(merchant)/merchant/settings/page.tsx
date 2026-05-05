'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { ImageLightbox } from '@/components/ImageLightbox'

// Dot thousand separator for bonus point inputs (LATAM convention).
const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

interface Settings {
  welcomeBonusAmount: number
  welcomeBonusActive: boolean
  welcomeBonusLimit: number | null
  referralBonusAmount: number
  referralBonusActive: boolean
  referralBonusLimit: number | null
  rif: string | null
  name: string
  logoUrl: string | null
  address: string | null
  contactPhone: string | null
  contactEmail: string | null
  website: string | null
  description: string | null
  instagramHandle: string | null
  preferredExchangeSource: string | null
  referenceCurrency: string
  crossBranchRedemption?: boolean
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
  const [welcomeActive, setWelcomeActive] = useState(true)
  const [welcomeLimit, setWelcomeLimit] = useState('')
  const [referralBonus, setReferralBonus] = useState('')
  const [referralActive, setReferralActive] = useState(true)
  const [referralLimit, setReferralLimit] = useState('')
  const [rif, setRif] = useState('')
  const [rifRaw, setRifRaw] = useState('')
  const [rifError, setRifError] = useState('')
  const [exchangeSource, setExchangeSource] = useState('')
  const [refCurrency, setRefCurrency] = useState('usd')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [description, setDescription] = useState('')
  const [instagramHandle, setInstagramHandle] = useState('')
  const [crossBranch, setCrossBranch] = useState(true)

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
      setWelcomeActive((s as any).welcomeBonusActive !== false)
      setWelcomeLimit((s as any).welcomeBonusLimit != null ? String((s as any).welcomeBonusLimit) : '')
      setReferralBonus(String((s as any).referralBonusAmount ?? ''))
      setReferralActive((s as any).referralBonusActive !== false)
      setReferralLimit((s as any).referralBonusLimit != null ? String((s as any).referralBonusLimit) : '')
      setRif(s.rif || '')
      // Collapse the stored canonical "J-12345678-9" into the single-input
      // form the UI now renders — letter + digits, no separators.
      setRifRaw(s.rif ? String(s.rif).toUpperCase().replace(/[^A-Z0-9]/g, '') : '')
      setExchangeSource(s.preferredExchangeSource || '')
      setRefCurrency(s.referenceCurrency || 'usd')
      setLogoUrl(s.logoUrl || null)
      setName(s.name || '')
      setAddress(s.address || '')
      setContactPhone(s.contactPhone || '')
      setContactEmail(s.contactEmail || '')
      setWebsite(s.website || '')
      setDescription(s.description || '')
      setInstagramHandle(s.instagramHandle || '')
      setCrossBranch(s.crossBranchRedemption !== false)
    } catch (e: any) {
      setMessage('Error: ' + (e.error || 'no se pudo cargar'))
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setMessage('')

    // Phone: 10-15 digits once you strip separators. Anything shorter is
    // obviously wrong, and merchants were pasting random text before.
    if (contactPhone.trim()) {
      const digits = contactPhone.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) {
        setMessage('Error: el telefono debe tener entre 10 y 15 digitos')
        return
      }
    }

    // Website: lightweight URL check — accept "something.something" with an
    // optional protocol. We're not trying to be a full RFC validator.
    if (website.trim()) {
      const w = website.trim()
      const urlLike = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i
      if (!urlLike.test(w)) {
        setMessage('Error: el sitio web no es valido. Ejemplo: www.micomercio.com')
        return
      }
    }

    // RIF: single input, normalize into canonical J-XXXXXXXX-X before send.
    // It's REQUIRED — the form rejects save on empty/missing RIF (Genesis M1
    // Re Do). The backend also enforces this; validating here just keeps the
    // user from hitting a round-trip to see the error.
    let rifValue: string | undefined = undefined;
    const cleaned = rifRaw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (cleaned.length === 0) {
      setRifError('El RIF es obligatorio.')
      setMessage('Error: el RIF es obligatorio')
      return
    }
    const m = cleaned.match(/^([JVEGP])(\d{7,9})(\d)$/)
    if (!m) {
      setRifError('RIF invalido. Ejemplo: J123456789')
      setMessage('Error: revisa el RIF')
      return
    }
    rifValue = `${m[1]}-${m[2]}-${m[3]}`

    setSaving(true)
    try {
      const updated = await api.updateMerchantSettings({
        welcomeBonusAmount: Number(welcomeBonus),
        welcomeBonusActive: welcomeActive,
        welcomeBonusLimit: welcomeLimit.trim() ? Number(welcomeLimit) : null,
        referralBonusAmount: Number(referralBonus || 0),
        referralBonusActive: referralActive,
        referralBonusLimit: referralLimit.trim() ? Number(referralLimit) : null,
        preferredExchangeSource: exchangeSource || null,
        referenceCurrency: refCurrency,
        logoUrl: logoUrl,
        name: name.trim(),
        address: address.trim() || null,
        contactPhone: contactPhone.trim() || null,
        contactEmail: contactEmail.trim() || null,
        website: website.trim() || null,
        description: description.trim() || null,
        instagramHandle: instagramHandle.trim().replace(/^@/, '') || null,
        crossBranchRedemption: crossBranch,
        ...(rifValue !== undefined ? { rif: rifValue } : {}),
      })
      setSettings(updated)
      setMessage('Guardado')
      // Update localStorage so other pages (dashboard header) pick up the logo
      if (updated.logoUrl) localStorage.setItem('tenantLogoUrl', updated.logoUrl)
      else localStorage.removeItem('tenantLogoUrl')
      if (updated.name) localStorage.setItem('tenantName', updated.name)
      setTimeout(() => setMessage(''), 2500)
    } catch (e: any) {
      setMessage('Error: ' + (e.error || 'no se pudo guardar'))
    } finally {
      setSaving(false)
    }
  }

  // Eric 2026-05-04 (Notion "Configuracion de puntos de bienvenida y de
  // referidos"): merchants flipped these ON/OFF toggles and walked away
  // without scrolling to the Guardar button at the bottom of the form.
  // Auto-save the toggle on click — the rest of the form fields still
  // wait for the explicit Guardar.
  async function autoSaveBonusToggle(field: 'welcomeBonusActive' | 'referralBonusActive', next: boolean) {
    const prev = field === 'welcomeBonusActive' ? welcomeActive : referralActive
    if (field === 'welcomeBonusActive') setWelcomeActive(next)
    else setReferralActive(next)
    setMessage('')
    try {
      await api.updateMerchantSettings({ [field]: next } as any)
      setMessage(next ? 'Bono activado' : 'Bono desactivado')
      setTimeout(() => setMessage(''), 2500)
    } catch (e: any) {
      // Revert on failure so the visible state matches reality.
      if (field === 'welcomeBonusActive') setWelcomeActive(prev)
      else setReferralActive(prev)
      setMessage('Error: ' + (e?.error || 'no se pudo guardar'))
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Eric 2026-05-04: no client-side size guard, backend handles the
    // ceiling. The merchant should be able to upload a phone photo
    // straight off the camera roll without resizing.
    setUploadingLogo(true)
    setMessage('')
    try {
      const result = await api.uploadProductImage(file)
      setLogoUrl(result.url)
      setMessage('Logo subido. Pulsa Guardar para confirmar.')
    } catch (err: any) {
      setMessage('Error al subir logo: ' + (err?.error || err?.message || 'desconocido'))
    }
    setUploadingLogo(false)
    e.target.value = ''
  }

  function removeLogo() {
    setLogoUrl(null)
    setMessage('Logo removido. Pulsa Guardar para confirmar.')
  }

  const currentRate = rates.find(r => r.source === exchangeSource && r.currency === refCurrency)

  if (loading) return <div className="p-8 text-center text-slate-400">Cargando...</div>

  return (
    <div className="min-h-screen bg-slate-50">
      <ImageLightbox src={lightboxSrc} alt="Logo" onClose={() => setLightboxSrc(null)} />
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Configuracion</h1>
        <p className="text-sm text-slate-500 mt-1">Ajustes del comercio, tasa de cambio y plan</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {message && (
          <div className={`aa-pop mb-4 p-3 rounded-xl text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left column */}
          <div className="space-y-6">
            {/* Merchant info */}
            <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
              <h2 className="font-semibold text-slate-800 text-lg mb-1">Informacion del comercio</h2>
              <p className="text-xs text-slate-500 mb-4">Estos datos se muestran a los clientes en la PWA y reciben en las notificaciones.</p>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre del comercio <span className="text-red-500">*</span></label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} maxLength={255}
                    placeholder="Ej: Farmacia Central"
                    className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion</label>
                  <input type="text" value={address} onChange={e => setAddress(e.target.value)} maxLength={500}
                    placeholder="Av. Principal, Valencia, Carabobo"
                    className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Telefono de contacto</label>
                    <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} maxLength={30}
                      placeholder="0414-1234567"
                      className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Email de contacto</label>
                    <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} maxLength={255}
                      placeholder="info@comercio.com"
                      className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sitio web</label>
                    <input type="text" value={website} onChange={e => setWebsite(e.target.value)} maxLength={500}
                      placeholder="www.micomercio.com"
                      className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Instagram</label>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">@</span>
                      <input type="text" value={instagramHandle} onChange={e => setInstagramHandle(e.target.value.replace(/^@/, ''))} maxLength={100}
                        placeholder="micomercio"
                        className="w-full pl-7 pr-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Descripcion</label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={1000}
                    placeholder="Breve descripcion del comercio y los servicios que ofrece."
                    className="w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm h-20 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                  <p className="text-xs text-slate-400 mt-1">{description.length}/1000</p>
                </div>
              </div>
            </section>

            {/* General */}
            <section className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
              <h2 className="font-semibold text-slate-800 text-lg mb-4">General</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Logo del comercio</label>
                  <div className="mt-2 flex items-center gap-4">
                    {logoUrl ? (
                      <button
                        type="button"
                        onClick={() => setLightboxSrc(logoUrl)}
                        className="group relative cursor-zoom-in"
                        aria-label="Ver logo en grande"
                      >
                        <img src={logoUrl} alt="Logo" className="w-20 h-20 rounded-xl object-cover border border-slate-200 transition group-hover:opacity-90 group-hover:scale-[1.02]" />
                        <span className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/20 flex items-center justify-center text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition">Ver</span>
                      </button>
                    ) : (
                      <div className="w-20 h-20 rounded-xl bg-slate-100 border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 text-xs text-center px-2">
                        Sin logo
                      </div>
                    )}
                    <div className="flex-1 space-y-2">
                      <label className="inline-block cursor-pointer bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-emerald-700 transition">
                        {uploadingLogo ? 'Subiendo...' : logoUrl ? 'Cambiar logo' : 'Subir logo'}
                        <input type="file" accept="image/*" onChange={handleLogoUpload} disabled={uploadingLogo} className="hidden" />
                      </label>
                      {logoUrl && (
                        <button onClick={removeLogo} className="block text-xs text-red-600 hover:text-red-800 font-medium">
                          Quitar logo
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 mt-2">Formato recomendado: cuadrado, 400x400px. Se mostrara en el menu del dashboard.</p>
                </div>
                <div className="rounded-xl border border-slate-200 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Bono de bienvenida</label>
                    <button
                      type="button"
                      onClick={() => autoSaveBonusToggle('welcomeBonusActive', !welcomeActive)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${welcomeActive ? 'bg-emerald-600' : 'bg-slate-300'}`}
                      aria-label="Activar/desactivar bono de bienvenida"
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${welcomeActive ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  <input type="text" inputMode="numeric"
                    value={fmtThousands(welcomeBonus)}
                    onChange={e => setWelcomeBonus(stripNonDigits(e.target.value))}
                    disabled={!welcomeActive}
                    placeholder="Cantidad de puntos"
                    className="aa-field aa-field-emerald w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400" />
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cupo (opcional)</label>
                    <input type="text" inputMode="numeric"
                      value={fmtThousands(welcomeLimit)}
                      onChange={e => setWelcomeLimit(stripNonDigits(e.target.value))}
                      disabled={!welcomeActive}
                      placeholder="Sin limite"
                      className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400" />
                    <p className="text-xs text-slate-400 mt-1">Limite de bonos a entregar (ej: 20 primeros clientes). Vacio = sin limite.</p>
                  </div>
                  <p className="text-xs text-slate-400">Cuando esta apagado o se llena el cupo, el bot deja de mencionarlo en el saludo.</p>
                </div>
                <div className="rounded-xl border border-slate-200 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Bono por referido</label>
                    <button
                      type="button"
                      onClick={() => autoSaveBonusToggle('referralBonusActive', !referralActive)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${referralActive ? 'bg-emerald-600' : 'bg-slate-300'}`}
                      aria-label="Activar/desactivar bono por referido"
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${referralActive ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  <input type="text" inputMode="numeric"
                    value={fmtThousands(referralBonus)}
                    onChange={e => setReferralBonus(stripNonDigits(e.target.value))}
                    disabled={!referralActive}
                    placeholder="Cantidad de puntos"
                    className="aa-field aa-field-emerald w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400" />
                  <div>
                    <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cupo (opcional)</label>
                    <input type="text" inputMode="numeric"
                      value={fmtThousands(referralLimit)}
                      onChange={e => setReferralLimit(stripNonDigits(e.target.value))}
                      disabled={!referralActive}
                      placeholder="Sin limite"
                      className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-50 disabled:text-slate-400" />
                    <p className="text-xs text-slate-400 mt-1">Limite de bonos a entregar antes de pausar el programa. Vacio = sin limite.</p>
                  </div>
                  <p className="text-xs text-slate-400">Apaga el toggle o llena el cupo para detener nuevos pagos sin perder los referidos ya validados.</p>
                </div>

                {/* RIF — single input: letter + digits, no separators.
                    We normalize into J-XXXXXXXX-X before sending. */}
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">RIF del comercio <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={rifRaw}
                    onChange={e => {
                      const cleaned = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)
                      setRifRaw(cleaned)
                      if (rifError) setRifError('')
                    }}
                    placeholder="Ej: J123456789"
                    className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm tabular-nums"
                  />
                  {rifError && <p className="text-xs text-red-600 mt-1">{rifError}</p>}
                  <p className="text-xs text-slate-400 mt-1">
                    Obligatorio. Empieza con J, V, E, G o P y luego los numeros. Solo aceptamos facturas fiscales donde aparezca este mismo RIF.
                  </p>
                </div>

                {/* Cross-branch redemption policy (Genesis H11) */}
                <div className="pt-2 border-t border-slate-100">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={crossBranch}
                      onChange={e => setCrossBranch(e.target.checked)}
                      className="mt-1 w-4 h-4 text-emerald-600 border-slate-300 rounded focus:ring-emerald-500"
                    />
                    <div>
                      <p className="text-sm font-semibold text-slate-700">Canje entre sucursales</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {crossBranch
                          ? 'Los clientes pueden canjear sus puntos en cualquier sucursal.'
                          : 'Los clientes solo pueden canjear en la sucursal donde generaron el codigo QR.'}
                      </p>
                    </div>
                  </label>
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
              className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-emerald-700 flex items-center justify-center">
              {saving && <span className="aa-spinner" />}<span className="relative z-10">{saving ? 'Guardando...' : 'Guardar cambios'}</span>
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
                  {Object.entries(planUsage.usage).map(([key, u]) => {
                    // CSV uploads: show the counter and progress bar but
                    // hide the "/limit" suffix and never switch to red —
                    // Genesis asked for the bar to stay visible as a
                    // month-to-month activity indicator while the backend
                    // runs without any hard cap on uploads.
                    const hideLimit = key === 'csv_uploads';
                    const barColor = hideLimit
                      ? 'bg-emerald-500'
                      : u.percent >= 90 ? 'bg-red-500'
                      : u.percent >= 70 ? 'bg-amber-500'
                      : 'bg-emerald-500';
                    return (
                      <div key={key}>
                        <div className="flex justify-between text-sm text-slate-600 mb-1.5">
                          <span>{ACTION_LABELS[key] || key}</span>
                          <span className="font-semibold text-slate-800">
                            {hideLimit ? u.current : `${u.current} / ${u.limit}`}
                          </span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${barColor}`}
                            style={{ width: `${Math.min(100, u.percent)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
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
