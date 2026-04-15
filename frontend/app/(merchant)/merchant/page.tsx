'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

const EVENT_LABELS: Record<string, string> = {
  INVOICE_CLAIMED: 'Factura validada',
  REDEMPTION_PENDING: 'Canje pendiente',
  REDEMPTION_CONFIRMED: 'Canje confirmado',
  REDEMPTION_EXPIRED: 'Canje expirado',
  REVERSAL: 'Reverso',
  ADJUSTMENT_MANUAL: 'Ajuste manual',
  PROVISIONAL: 'Provisional',
  WELCOME_BONUS: 'Bono de bienvenida',
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

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('staffRole')
    localStorage.removeItem('staffName')
    router.push('/merchant/login')
  }

  if (role === 'cashier') return null

  return (
    <div className="min-h-screen bg-slate-50">
      {(() => {
        const branchLabel = selectedBranch
          ? (branches.find(b => b.id === selectedBranch)?.name || 'Sucursal')
          : (branches.length > 0 ? 'Todas las sucursales' : 'Dashboard')
        return (
          <>
            {/* Mobile-only header */}
            <div className="lg:hidden bg-emerald-700 text-white px-4 py-4 flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold">Bienvenido{staffName ? `, ${staffName}` : ''}</h1>
                <p className="text-emerald-200 text-xs mt-0.5">{branchLabel}</p>
              </div>
              <button onClick={logout} className="text-sm text-emerald-200 hover:text-white">Salir</button>
            </div>

            {/* Page title (desktop only) */}
            <div className="hidden lg:block px-8 pt-8 pb-4">
              <h1 className="text-3xl font-bold text-slate-800">Bienvenido{staffName ? `, ${staffName}` : ''}</h1>
              <p className="text-slate-500 text-sm mt-1">{branchLabel}</p>
            </div>
          </>
        )
      })()}

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Top row: Branch selector (if exists) + Multiplier card side by side */}
        <div className={`grid gap-4 mt-4 lg:mt-0 ${branches.length > 0 ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1'}`}>
          {branches.length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-100 lg:col-span-1">
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Sucursal</label>
              <select
                value={selectedBranch}
                onChange={e => setSelectedBranch(e.target.value)}
                className="w-full mt-2 px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">Todas las sucursales</option>
                {branches.filter(b => b.active).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          )}

          {multiplier && (
            <div className={`bg-white rounded-xl p-5 shadow-sm border border-slate-100 ${branches.length > 0 ? 'lg:col-span-2' : ''}`}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Multiplicador de puntos</p>
                  <p className="text-4xl font-bold text-emerald-700 mt-1">{parseFloat(parseFloat(multiplier.currentRate).toFixed(2))}x</p>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  {['1', '1.5', '2', '3'].map(m => (
                    <button key={m} onClick={() => setNewMultiplier(m)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition ${newMultiplier === m ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                      {m}x
                    </button>
                  ))}
                  <input type="number" step="0.1" min="0.1" placeholder="Otro"
                    value={!['1','1.5','2','3'].includes(newMultiplier) ? newMultiplier : ''}
                    onChange={e => setNewMultiplier(e.target.value)}
                    className="w-20 px-2 py-2 rounded-lg border border-slate-200 text-sm" />
                  {newMultiplier && (
                    <button onClick={handleSetMultiplier} className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700">
                      Aplicar
                    </button>
                  )}
                </div>
              </div>
              {multiplierMsg && <p className="text-sm text-emerald-600 mt-2">{multiplierMsg}</p>}
            </div>
          )}
        </div>

        {/* Metrics Cards — 2 cols mobile, 3 cols tablet, 6 cols desktop */}
        {(metrics || analytics) && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 lg:gap-4 mt-6">
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Emitido</p>
              <p className="text-xl lg:text-2xl font-bold text-emerald-700 mt-1 truncate">
                {Math.round(parseFloat(metrics?.valueIssued || analytics?.valueIssued || '0')).toLocaleString()}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjeado</p>
              <p className="text-xl lg:text-2xl font-bold text-emerald-700 mt-1 truncate">
                {Math.round(parseFloat(metrics?.valueRedeemed || analytics?.valueRedeemed || '0')).toLocaleString()}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Circulacion</p>
              <p className="text-xl lg:text-2xl font-bold text-indigo-600 mt-1 truncate">
                {Math.round(parseFloat(metrics?.netCirculation || analytics?.netBalance || '0')).toLocaleString()}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Activos 30d</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1">
                {metrics?.activeConsumers30d ?? analytics?.consumerCount ?? 0}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjes tot.</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1">
                {metrics?.totalRedemptions ?? 0}
              </p>
            </div>
            <div className="bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Canjes 30d</p>
              <p className="text-xl lg:text-2xl font-bold text-slate-800 mt-1">
                {metrics?.redemptions30d ?? 0}
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-xl p-1 shadow-sm border border-slate-100 mt-6 w-full">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
            <Link href="/merchant/scanner" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Escaner QR</p>
              <p className="text-xs text-slate-500 mt-1">Escanear codigos de canje de clientes</p>
            </Link>
            <Link href="/merchant/dual-scan" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Transaccion sin factura</p>
              <p className="text-xs text-slate-500 mt-1">Generar QR para clientes (Pago Movil, efectivo, sin recibo)</p>
            </Link>
            <Link href="/merchant/csv-upload" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Cargar CSV de facturas</p>
              <p className="text-xs text-slate-500 mt-1">Subir el archivo diario de transacciones del POS</p>
            </Link>
            <Link href="/merchant/products" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Catalogo de productos</p>
              <p className="text-xs text-slate-500 mt-1">Agregar, editar y gestionar productos</p>
            </Link>
            <Link href="/merchant/hybrid-deals" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Promociones hibridas</p>
              <p className="text-xs text-slate-500 mt-1">Ofertas combinadas de efectivo + puntos</p>
            </Link>
            <Link href="/merchant/customers" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Buscar cliente</p>
              <p className="text-xs text-slate-500 mt-1">Consultar cuentas y vincular cedula</p>
            </Link>
            <Link href="/merchant/branches" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Sucursales</p>
              <p className="text-xs text-slate-500 mt-1">Gestionar sucursales y sus QRs</p>
            </Link>
            <Link href="/merchant/disputes" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Disputas</p>
              <p className="text-xs text-slate-500 mt-1">Resolver reclamos de clientes</p>
            </Link>
            <Link href="/merchant/recurrence" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
              <p className="font-semibold text-slate-800">Recurrencia</p>
              <p className="text-xs text-slate-500 mt-1">Reglas de retencion automatica por WhatsApp</p>
            </Link>
            <Link href="/merchant/settings" className="block bg-white rounded-xl p-5 shadow-sm border border-slate-100 hover:shadow-md hover:border-emerald-200 transition">
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
                <div key={p.productId} className="bg-white rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-medium text-sm">{p.name}</p>
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                      Stock: {p.stock}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-xs text-slate-500">Canjes totales</p>
                      <p className="font-bold text-emerald-700">{p.redemptionsTotal}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Canjes (30d)</p>
                      <p className="font-bold text-emerald-700">{p.redemptions30d}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Valor canjeado</p>
                      <p className="font-bold text-indigo-600">{Math.round(parseFloat(p.totalValueRedeemed)).toLocaleString()}</p>
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
            {branches.length > 0 && (
              <div>
                <label className="text-xs text-slate-500">Sucursal</label>
                <select value={txFilters.branchId}
                  onChange={e => handleFilterChange('branchId', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-sm">
                  <option value="">Todas</option>
                  {branches.filter(b => b.active).map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
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
                  <div key={tx.id} className="bg-white rounded-xl p-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{EVENT_LABELS[tx.eventType] || tx.eventType}</p>
                        <p className="text-xs text-slate-400">{new Date(tx.createdAt).toLocaleString('es-VE')}</p>
                        {tx.accountPhone && <p className="text-xs text-slate-400">{tx.accountPhone}</p>}
                        {tx.branchName && <p className="text-xs text-slate-400">Sucursal: {tx.branchName}</p>}
                      </div>
                      <div className="text-right">
                        <p className={`font-bold text-sm ${tx.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                          {tx.entryType === 'CREDIT' ? '+' : '-'}{Math.round(parseFloat(tx.amount)).toLocaleString()}
                        </p>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
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
