'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatPoints } from '@/lib/format'

const EVENT_LABELS: Record<string, string> = {
  INVOICE_CLAIMED: 'Factura validada',
  PRESENCE_VALIDATED: 'Pago en efectivo',
  REDEMPTION_PENDING: 'Canje pendiente',
  REDEMPTION_CONFIRMED: 'Canje confirmado',
  REDEMPTION_EXPIRED: 'Canje expirado',
  REVERSAL: 'Reverso',
  ADJUSTMENT_MANUAL: 'Ajuste manual',
  PROVISIONAL: 'Provisional',
  WELCOME_BONUS: 'Puntos de Bienvenida',
  REFERRAL_BONUS: 'Bono por Referido',
}

const EVENT_TYPES = [
  { value: '', label: 'Todos' },
  { value: 'INVOICE_CLAIMED', label: 'Factura validada' },
  { value: 'REDEMPTION_CONFIRMED', label: 'Canje confirmado' },
  { value: 'REDEMPTION_PENDING', label: 'Canje pendiente' },
  { value: 'REDEMPTION_EXPIRED', label: 'Canje expirado' },
  { value: 'REVERSAL', label: 'Reverso' },
  { value: 'ADJUSTMENT_MANUAL', label: 'Ajuste manual' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'confirmed', label: 'Confirmado' },
  { value: 'provisional', label: 'En verificacion' },
  { value: 'reversed', label: 'Revertido' },
]

interface ProductPerf {
  productId: string
  name: string
  photoUrl: string | null
  stock: number
  redemptionsTotal: number
  redemptions30d: number
  totalValueRedeemed: string
}

interface TransactionEntry {
  id: string
  eventType: string
  entryType: string
  amount: string
  status: string
  referenceId: string
  branchId: string | null
  branchName: string | null
  accountPhone: string | null
  accountName: string | null
  productName: string | null
  productPhotoUrl: string | null
  invoiceNumber: string | null
  createdAt: string
}

interface Branch {
  id: string
  name: string
  active: boolean
}

export default function MerchantDashboard() {
  const [role, setRole] = useState('')
  const [staffName, setStaffName] = useState('')
  const [analytics, setAnalytics] = useState<any>(null)
  const router = useRouter()

  // Branches
  const [branches, setBranches] = useState<Branch[]>([])
  const [selectedBranch, setSelectedBranch] = useState('')

  // Metrics (enhanced)
  const [metrics, setMetrics] = useState<any>(null)

  // Product performance
  const [productPerf, setProductPerf] = useState<ProductPerf[]>([])

  // Transactions
  const [transactions, setTransactions] = useState<TransactionEntry[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txOffset, setTxOffset] = useState(0)
  const [txFilters, setTxFilters] = useState({ startDate: '', endDate: '', eventType: '', status: '', branchId: '' })
  const [txLoading, setTxLoading] = useState(false)

  // Active tab
  const [activeTab, setActiveTab] = useState<'overview' | 'products' | 'transactions'>('overview')

  useEffect(() => {
    const r = localStorage.getItem('staffRole')
    const n = localStorage.getItem('staffName')
    if (!r) { router.push('/merchant/login'); return }
    setRole(r)
    setStaffName(n || '')
    if (r === 'cashier') { router.push('/merchant/scanner'); return }
    loadAnalytics()
    loadBranches()
    loadProductPerformance()
  }, [router])

  useEffect(() => {
    if (role === 'owner') {
      loadMetrics()
    }
  }, [role, selectedBranch])

  useEffect(() => {
    if (role === 'owner') {
      loadTransactions()
    }
  }, [role, txFilters, txOffset])

  // If the merchant clears all unassigned data (or it never existed) but
  // had previously selected '_unassigned', reset to "Todas las sucursales"
  // so the UI doesn't get stuck filtering an empty bucket.
  useEffect(() => {
    const hasUnassigned = !!metrics?.valueIssuedUnassigned && parseFloat(metrics.valueIssuedUnassigned) > 0
    if (!hasUnassigned) {
      if (selectedBranch === '_unassigned') setSelectedBranch('')
      if (txFilters.branchId === '_unassigned') setTxFilters(f => ({ ...f, branchId: '' }))
    }
  }, [metrics?.valueIssuedUnassigned])

  async function loadAnalytics() {
    try { setAnalytics(await api.getAnalytics()) } catch {}
  }

  async function loadBranches() {
    try {
      const data = await api.getBranches()
      setBranches(data.branches || [])
    } catch {}
  }

  async function loadMetrics() {
    try {
      const data = await api.getMerchantMetrics(selectedBranch || undefined)
      setMetrics(data)
    } catch {}
  }

  async function loadProductPerformance() {
    try {
      const data = await api.getProductPerformance()
      setProductPerf(data.products || [])
    } catch {}
  }

  async function loadTransactions() {
    setTxLoading(true)
    try {
      const params: Record<string, string> = {
        limit: '50',
        offset: String(txOffset),
      }
      if (txFilters.startDate) params.startDate = new Date(txFilters.startDate).toISOString()
      if (txFilters.endDate) params.endDate = new Date(txFilters.endDate + 'T23:59:59').toISOString()
      if (txFilters.eventType) params.eventType = txFilters.eventType
      if (txFilters.status) params.status = txFilters.status
      if (txFilters.branchId) params.branchId = txFilters.branchId

      const data = await api.getTransactions(params)
      setTransactions(data.entries || [])
      setTxTotal(data.total || 0)
    } catch {}
    setTxLoading(false)
  }

  function handleFilterChange(key: string, value: string) {
    setTxFilters(prev => ({ ...prev, [key]: value }))
    setTxOffset(0)
  }

  const [multiplier, setMultiplier] = useState<any>(null)
  const [newMultiplier, setNewMultiplier] = useState('')
  const [multiplierMsg, setMultiplierMsg] = useState('')

  useEffect(() => {
    if (role === 'owner') loadMultiplier()
  }, [role])

  async function loadMultiplier() {
    try { setMultiplier(await api.getMultiplier()) } catch {}
  }

  async function handleSetMultiplier() {
    if (!newMultiplier || !multiplier?.assetTypeId) return
    setMultiplierMsg('')
    try {
      await api.setMultiplier(newMultiplier, multiplier.assetTypeId)
      setMultiplierMsg(`Multiplicador actualizado a ${newMultiplier}x`)
      setNewMultiplier('')
      loadMultiplier()
    } catch { setMultiplierMsg('Error al actualizar') }
  }

  async function logout() {
    const { clearTokens } = await import('@/lib/token-store')
    clearTokens('staff')
    localStorage.removeItem('staffRole')
    localStorage.removeItem('staffName')
    router.push('/merchant/login')
  }

  if (role === 'cashier') return null

  return (
    <div className="min-h-screen bg-slate-50">
      {(() => {
        const activeBranches = branches.filter(b => b.active)
        const branchLabel = selectedBranch
          ? (branches.find(b => b.id === selectedBranch)?.name || 'Sucursal')
          : (activeBranches.length >= 2 ? 'Todas las sucursales' : (activeBranches[0]?.name || 'Dashboard'))
        return (
          <>
            {/* Mobile-only header */}
            <div className="lg:hidden bg-emerald-700 text-white px-4 py-4 flex items-center justify-between aa-rise-sm">
              <div>
                <h1 className="text-lg font-bold tracking-tight">Bienvenido{staffName ? `, ${staffName}` : ''}</h1>
                <p className="text-emerald-200 text-xs mt-0.5">{branchLabel}</p>
              </div>
              <button onClick={logout} className="text-sm text-emerald-200 hover:text-white transition-colors">Salir</button>
            </div>

            {/* Page title (desktop only) */}
            <div className="hidden lg:block px-8 pt-8 pb-4 aa-rise">
              <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Bienvenido{staffName ? `, ${staffName}` : ''}</h1>
              <p className="text-slate-500 text-sm mt-1">{branchLabel}</p>
            </div>
          </>
        )
      })()}

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {metrics?.rifMissing && (
          <div className="mt-4 bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3">
            <div className="flex-1">
              <p className="font-semibold text-amber-900">Falta configurar tu RIF</p>
              <p className="text-sm text-amber-800 mt-1">Las facturas fiscales se rechazan automaticamente hasta que lo agregues. Completalo en Configuracion.</p>
            </div>
            <Link href="/merchant/settings" className="text-sm font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 px-3 py-2 rounded-lg transition whitespace-nowrap">
              Configurar RIF
            </Link>
          </div>
        )}

        {/* Top row: Branch selector (if exists) + Multiplier card side by side */}
        <div className={`grid gap-4 mt-4 lg:mt-0 ${branches.filter(b => b.active).length > 0 ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1'}`}>
          {branches.filter(b => b.active).length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-100 lg:col-span-1">
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursal</label>
              <select
                value={selectedBranch}
                onChange={e => {
                  const v = e.target.value
                  setSelectedBranch(v)
                  // Keep the transactions list in sync with the top selector.
                  // '_unassigned' now propagates: the transactions endpoint
                  // accepts it and filters to branch_id IS NULL rows.
                  setTxFilters(f => ({ ...f, branchId: v }))
                }}
                className="aa-field aa-field-emerald w-full mt-2 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
              >
                <option value="">Todas las sucursales (total comercio)</option>
                {branches.filter(b => b.active).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
                {/* Eric 2026-04-25: when the comercio works with sucursales,
                    the "sin sucursal" option must NEVER appear — every nuevo
                    movimiento se atribuye a una. Solo aparece cuando el
                    comercio NO tiene ninguna sucursal activa, en cuyo caso
                    el merchant es una tienda unica. (El wrapper de afuera
                    ya esconde el selector entero si no hay branches, asi que
                    en la practica esta opcion ya no se renderiza nunca aqui.) */}
              </select>
            </div>
          )}

          {multiplier && (() => {
            const rateNow = parseFloat(multiplier.currentRate) || 1
            const previewRate = newMultiplier ? (parseFloat(newMultiplier) || rateNow) : rateNow
            const sample = 10 // $10 sample purchase
            // 1000 pts = $1 baseline redemption value, so cashback % = rate / 10.
            const pct = (r: number) => `${(r / 10).toFixed(r % 10 === 0 ? 0 : 1)}%`
            // Eric 2026-04-25: marketing-facing label adds a zero to the
            // raw rate (50x → 500x) so it reads bigger to the merchant when
            // they pick a tier. Underlying rate stored unchanged (still 50)
            // so cashback math + the $10 example stay correct.
            const labelX = (r: number) => `${(r * 10).toLocaleString('es-VE')}x`
            const presets: Array<{ value: string; label: string }> = [
              { value: '50',  label: '5%' },
              { value: '100', label: '10%' },
              { value: '150', label: '15%' },
              { value: '200', label: '20%' },
            ]
            return (
              <div className={`bg-white rounded-xl p-5 shadow-sm border border-slate-100 ${branches.filter(b => b.active).length > 0 ? 'lg:col-span-2' : ''}`}>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Multiplicador de puntos</p>
                    <p className="text-4xl font-bold text-emerald-700 mt-1">{labelX(rateNow)}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Cada <span className="font-semibold">$10</span> gastados = <span className="font-semibold">{Math.round(rateNow * 10).toLocaleString('es-VE')}</span> puntos
                      <span className="text-emerald-700"> ({pct(rateNow)} cashback)</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    {/* Eric 2026-04-24 (IMG_6760): presets 50/100/150/200, cada
                        uno muestra el cashback equivalente para que el owner
                        decida por impacto economico y no por un numero suelto.
                        Eric 2026-04-25: label muestra 500x/1.000x/1.500x/2.000x
                        (rate * 10) — solo cosmetico, el value enviado al backend
                        sigue siendo 50/100/150/200. */}
                    {presets.map(p => (
                      <button key={p.value} onClick={() => setNewMultiplier(p.value)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition flex flex-col items-center leading-tight ${newMultiplier === p.value ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                        <span>{labelX(parseFloat(p.value))}</span>
                        <span className={`text-[10px] ${newMultiplier === p.value ? 'text-emerald-100' : 'text-emerald-600/70'}`}>{p.label}</span>
                      </button>
                    ))}
                    <input type="number" step="1" min="0.1" placeholder="Otro"
                      value={newMultiplier}
                      onChange={e => setNewMultiplier(e.target.value)}
                      className="w-24 px-3 py-2 rounded-lg border border-slate-200 text-sm" />
                    {newMultiplier && (
                      <button onClick={handleSetMultiplier} className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700">
                        Aplicar
                      </button>
                    )}
                  </div>
                </div>
                {/* Live preview: make the math obvious so the owner can pick
                    the scale that reads cleanly to their customers. */}
                <div className="mt-3 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 text-xs text-emerald-800">
                  Ejemplo: si un cliente gasta <span className="font-semibold">${sample}</span>, gana{' '}
                  <span className="font-semibold">{Math.round(sample * previewRate).toLocaleString('es-VE')} puntos</span>
                  <span className="text-emerald-700"> ({pct(previewRate)} cashback)</span>
                  {newMultiplier && previewRate !== rateNow && (
                    <span className="text-emerald-700/70"> (con el nuevo {labelX(previewRate)})</span>
                  )}.
                </div>
                {multiplierMsg && <p className="text-sm text-emerald-600 mt-2">{multiplierMsg}</p>}
              </div>
            )
          })()}
        </div>

        {/* Metrics Cards — 2 cols mobile, 3 cols tablet, 6 cols desktop */}
        {(metrics || analytics) && (
          <div className="aa-stagger grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 lg:gap-4 mt-6">
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Emitido</p>
              <p className="text-xl lg:text-2xl font-bold text-emerald-700 mt-1 truncate tabular-nums">
                {formatPoints(metrics?.valueIssued || analytics?.valueIssued || '0')}
              </p>
              {metrics && (
                <div className="mt-1.5 space-y-0.5 text-[10px] text-slate-500 leading-tight">
                  <p className="flex justify-between gap-2"><span>Facturas</span><span className="tabular-nums">{formatPoints(metrics.valueIssuedInvoices || '0')}</span></p>
                  <p className="flex justify-between gap-2"><span>Bienvenidas</span><span className="tabular-nums">{formatPoints(metrics.valueIssuedWelcome || '0')}</span></p>
                  <p className="flex justify-between gap-2"><span>Referidos</span><span className="tabular-nums">{formatPoints(metrics.valueIssuedReferrals || '0')}</span></p>
                  <p className="flex justify-between gap-2"><span>Manuales</span><span className="tabular-nums">{formatPoints(metrics.valueIssuedManual || '0')}</span></p>
                </div>
              )}
            </div>
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjeado</p>
              <p className="text-xl lg:text-2xl font-bold text-emerald-700 mt-1 truncate tabular-nums">
                {formatPoints(metrics?.valueRedeemed || analytics?.valueRedeemed || '0')}
              </p>
            </div>
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Circulacion</p>
              {/* Clamp to 0 for display — negative circulacion means
                  consumers are spending points awarded before the filter
                  window, which is correct ledger-wise but looks alarming
                  in a tile. The raw ledger state is still available to
                  the admin in /admin/ledger. */}
              {(() => {
                const raw = Number(metrics?.netCirculation ?? analytics?.netBalance ?? 0)
                const display = Math.max(0, raw)
                return (
                  <>
                    <p className="text-xl lg:text-2xl font-bold text-indigo-600 mt-1 truncate tabular-nums">
                      {formatPoints(String(display))}
                    </p>
                    {raw < 0 && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Se canjearon puntos previos a esta ventana
                      </p>
                    )}
                  </>
                )
              })()}
            </div>
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Activos 30d</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1 tabular-nums">
                {metrics?.activeConsumers30d ?? analytics?.consumerCount ?? 0}
              </p>
            </div>
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjes tot.</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1 tabular-nums">
                {metrics?.totalRedemptions ?? 0}
              </p>
            </div>
            <div className="aa-card bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjes 30d</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1 tabular-nums">
                {metrics?.redemptions30d ?? 0}
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-xl p-1 shadow-sm border border-slate-100 mt-6 w-full aa-rise" style={{ animationDelay: '200ms' }}>
          {(['overview', 'products', 'transactions'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all ${
                activeTab === tab
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'
              }`}
            >
              {tab === 'overview' ? 'General' : tab === 'products' ? 'Productos' : 'Transacciones'}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <div className="aa-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
            <Link href="/merchant/scanner" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Escaner QR</p>
              <p className="text-xs text-slate-500 mt-1">Escanear codigos de canje de clientes</p>
            </Link>
            <Link href="/merchant/dual-scan" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Transaccion sin factura</p>
              <p className="text-xs text-slate-500 mt-1">Generar QR para clientes (Pago Movil, efectivo, sin recibo)</p>
            </Link>
            <Link href="/merchant/csv-upload" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Cargar CSV de facturas</p>
              <p className="text-xs text-slate-500 mt-1">Subir el archivo diario de transacciones del POS</p>
            </Link>
            <Link href="/merchant/products" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Catalogo de productos</p>
              <p className="text-xs text-slate-500 mt-1">Agregar, editar y gestionar productos</p>
            </Link>
            <Link href="/merchant/hybrid-deals" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Promociones hibridas</p>
              <p className="text-xs text-slate-500 mt-1">Ofertas combinadas de efectivo + puntos</p>
            </Link>
            <Link href="/merchant/customers" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Buscar cliente</p>
              <p className="text-xs text-slate-500 mt-1">Consultar cuentas y vincular cedula</p>
            </Link>
            <Link href="/merchant/branches" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Sucursales</p>
              <p className="text-xs text-slate-500 mt-1">Gestionar sucursales y sus QRs</p>
            </Link>
            <Link href="/merchant/disputes" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Disputas</p>
              <p className="text-xs text-slate-500 mt-1">Resolver reclamos de clientes</p>
            </Link>
            <Link href="/merchant/recurrence" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Recurrencia</p>
              <p className="text-xs text-slate-500 mt-1">Reglas de retencion automatica por WhatsApp</p>
            </Link>
            <Link href="/merchant/segments" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100 relative">
              <span className="absolute top-3 right-3 text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">PREVIEW</span>
              <p className="font-semibold text-slate-800">Segmentos</p>
              <p className="text-xs text-slate-500 mt-1">Carpetas dinamicas de clientes para campanas</p>
            </Link>
            <Link href="/merchant/settings" className="aa-card block bg-white rounded-xl p-5 shadow-sm border border-slate-100">
              <p className="font-semibold text-slate-800">Configuracion</p>
              <p className="text-xs text-slate-500 mt-1">Bienvenida, RIF, tasa de cambio Bs/USD</p>
            </Link>
          </div>
        )}

      {activeTab === 'products' && (
        <div className="p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Rendimiento de productos</h3>
          {productPerf.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No hay productos registrados</p>
          ) : (
            <div className="space-y-3">
              {productPerf.map(p => (
                <div key={p.productId} className="aa-card bg-white rounded-xl p-4 shadow-sm flex gap-4 items-center">
                  {p.photoUrl ? (
                    <img src={p.photoUrl} alt={p.name} className="w-16 h-16 rounded-xl object-cover border border-slate-100 flex-shrink-0" />
                  ) : (
                    <div className="w-16 h-16 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-2xl">🎁</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="font-medium text-sm truncate">{p.name}</p>
                      <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full flex-shrink-0">
                        Stock: {p.stock}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-[11px] text-slate-500">Canjes totales</p>
                        <p className="font-bold text-emerald-700 tabular-nums">{p.redemptionsTotal}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">Canjes (30d)</p>
                        <p className="font-bold text-emerald-700 tabular-nums">{p.redemptions30d}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">Valor canjeado</p>
                        <p className="font-bold text-indigo-600 tabular-nums">{formatPoints(p.totalValueRedeemed)}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'transactions' && (
        <div className="p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Historial de transacciones</h3>

          {/* Filters */}
          <div className="bg-white rounded-xl p-4 shadow-sm mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-slate-500">Desde</label>
                <input type="date" value={txFilters.startDate}
                  onChange={e => handleFilterChange('startDate', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Hasta</label>
                <input type="date" value={txFilters.endDate}
                  onChange={e => handleFilterChange('endDate', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-slate-500">Tipo de evento</label>
                <select value={txFilters.eventType}
                  onChange={e => handleFilterChange('eventType', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm">
                  {EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500">Estado</label>
                <select value={txFilters.status}
                  onChange={e => handleFilterChange('status', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm">
                  {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            {branches.filter(b => b.active).length > 0 && (
              <div>
                <label className="text-xs text-slate-500">Sucursal</label>
                <select value={txFilters.branchId}
                  onChange={e => handleFilterChange('branchId', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm">
                  <option value="">Todas</option>
                  {branches.filter(b => b.active).map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                  {/* "Sin sucursal" no se ofrece cuando hay sucursales (Eric
                      2026-04-25). Si el comercio trabaja con sucursal, todo
                      deberia estar atribuido a una. */}
                </select>
              </div>
            )}
          </div>

          {/* Results */}
          {txLoading ? (
            <p className="text-center text-slate-400 py-8">Cargando...</p>
          ) : transactions.length === 0 ? (
            <p className="text-center text-slate-400 py-8">No se encontraron transacciones</p>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-2">{txTotal} transacciones encontradas</p>
              <div className="space-y-2">
                {transactions.map(tx => (
                  <div key={tx.id} className="aa-card bg-white rounded-xl p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        {tx.productPhotoUrl && (
                          <img src={tx.productPhotoUrl} alt={tx.productName || ''} className="w-11 h-11 rounded-lg object-cover border border-slate-100 flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-800 truncate">{EVENT_LABELS[tx.eventType] || tx.eventType}</p>
                          {tx.productName && (
                            <p className="text-xs text-indigo-600 font-medium truncate">{tx.productName}</p>
                          )}
                          {tx.invoiceNumber && (
                            <p className="text-xs text-slate-500 font-mono truncate">Factura #{tx.invoiceNumber}</p>
                          )}
                          <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2 items-center">
                            <span>{new Date(tx.createdAt).toLocaleString('es-VE')}</span>
                            {(tx.accountName || tx.accountPhone) && (
                              <span>· {tx.accountName || tx.accountPhone}</span>
                            )}
                            {/* Eric 2026-04-25: cuando el comercio trabaja con
                                sucursales, "Sin sucursal" no se debe mostrar
                                en ningun lado. Solo renderizamos el badge
                                cuando la fila tiene una sucursal real asignada. */}
                            {branches.filter(b => b.active).length > 0 && tx.branchName && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-indigo-50 text-indigo-700">
                                {tx.branchName}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`font-bold text-sm tabular-nums ${tx.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                          {tx.entryType === 'CREDIT' ? '+' : '-'}{formatPoints(tx.amount)}
                        </p>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded ${
                          tx.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                          tx.status === 'reversed' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {tx.status}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Pagination */}
              <div className="flex justify-between items-center mt-4">
                <button
                  onClick={() => setTxOffset(Math.max(0, txOffset - 50))}
                  disabled={txOffset === 0}
                  className="px-4 py-2 bg-white rounded-lg text-sm font-medium shadow-sm disabled:opacity-50"
                >
                  Anterior
                </button>
                <span className="text-xs text-slate-500">
                  {txOffset + 1}-{Math.min(txOffset + 50, txTotal)} de {txTotal}
                </span>
                <button
                  onClick={() => setTxOffset(txOffset + 50)}
                  disabled={txOffset + 50 >= txTotal}
                  className="px-4 py-2 bg-white rounded-lg text-sm font-medium shadow-sm disabled:opacity-50"
                >
                  Siguiente
                </button>
              </div>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
