'use client'

import { useState, useEffect } from 'react'
import { MdQrCode2, MdPersonAdd, MdBarChart, MdDownload, MdClose } from 'react-icons/md'
import { api } from '@/lib/api'
import { formatPoints } from '@/lib/format'

interface Staff {
  id: string
  name: string
  email: string
  role: 'owner' | 'cashier'
  active: boolean
  branchId: string | null
  branchChangeCount?: number
  branchLocked?: boolean
  qrSlug: string | null
  qrCodeUrl: string | null
  qrGeneratedAt: string | null
  qrRegenCount?: number
  qrRegenCap?: number
  qrRegenLocked?: boolean
  createdAt: string
}

interface Branch {
  id: string
  name: string
  active: boolean
}

interface PerformanceRow {
  staffId: string
  staffName: string
  staffRole: string
  transactions: number
  uniqueConsumers: number
  valueIssued: string
}

export default function StaffPage() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [perf, setPerf] = useState<PerformanceRow[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [tenantName, setTenantName] = useState<string>('Sede principal')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<string | null>(null)
  const [qrPreview, setQrPreview] = useState<{ name: string; url: string } | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'cashier' as 'cashier' | 'owner', branchId: '' })
  const [addError, setAddError] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [branchEdit, setBranchEdit] = useState<{ staff: Staff; branchId: string } | null>(null)
  const [branchEditError, setBranchEditError] = useState('')
  const [branchEditSubmitting, setBranchEditSubmitting] = useState(false)

  async function load() {
    try {
      const [s, p, b, settings] = await Promise.all([
        api.listStaff(),
        api.getStaffPerformance(30).catch(() => ({ staff: [] })),
        api.getBranches().catch(() => ({ branches: [] })),
        api.getMerchantSettings().catch(() => ({ name: '' })),
      ])
      setStaff((s as any).staff || [])
      setPerf(((p as any).staff || []) as PerformanceRow[])
      setBranches(((b as any).branches || []) as Branch[])
      // Surface the tenant's actual name as the dropdown label for the
      // main location so Eric sees e.g. "Kromi Parral (sede principal)"
      // instead of the generic "Sede principal (tu local)". Matches how
      // he names the tenant vs its branches in the real store ("Kromi
      // Parral" for the main local, "Kromi Manongo" for a sub-location).
      const name = (settings as any)?.name?.trim()
      if (name) setTenantName(name)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleGenerate(id: string) {
    const target = staff.find(s => s.id === id)
    // Regenerations (QR already exists) require a reason and are
    // capped at 2. Initial generation (no QR yet) just goes through.
    let reason: string | undefined
    if (target?.qrCodeUrl) {
      if (target.qrRegenLocked) {
        alert('Este QR ya fue regenerado 2 veces. Para otro cambio, comunicate con soporte@valee.app.')
        return
      }
      const input = prompt(`Vas a regenerar el QR de ${target.name}. Indica la razon del cambio (perdida, robo, cambio de rol, etc):`)
      if (!input || input.trim().length < 3) return
      reason = input.trim()
    }
    setGenerating(id)
    try {
      const res: any = await api.generateStaffQr(id, reason)
      await load()
      setQrPreview({
        name: target?.name || 'Cajero',
        url: res.qrCodeUrl,
      })
    } catch (e: any) {
      alert(e?.error || 'No pudimos generar el QR')
    } finally {
      setGenerating(null)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAddError('')
    const activeBranches = branches.filter(b => b.active)
    // Empty branchId in the form maps to "Sede principal" (tenant-level,
    // branchId=null). No need to block submission on it anymore.
    void activeBranches;
    setAddSubmitting(true)
    try {
      const payload: any = { ...form }
      if (!payload.branchId) delete payload.branchId
      await api.createStaff(payload)
      setShowAddForm(false)
      setForm({ name: '', email: '', password: '', role: 'cashier', branchId: '' })
      await load()
    } catch (e: any) {
      setAddError(e?.error || 'No pudimos crear el cajero')
    } finally {
      setAddSubmitting(false)
    }
  }

  async function handleBranchEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!branchEdit) return
    setBranchEditError('')
    setBranchEditSubmitting(true)
    try {
      // Empty selection in the edit modal maps to "sede principal" (null).
      const nextBranchId = branchEdit.branchId || null
      await api.changeStaffBranch(branchEdit.staff.id, nextBranchId)
      setBranchEdit(null)
      await load()
    } catch (e: any) {
      setBranchEditError(e?.error || 'No pudimos cambiar la sucursal')
    } finally {
      setBranchEditSubmitting(false)
    }
  }

  async function handleDeactivate(s: Staff) {
    if (!confirm(`Desactivar a ${s.name}? No podra iniciar sesion.`)) return
    try {
      await api.deactivateStaff(s.id)
      await load()
    } catch (e: any) {
      alert(e?.error || 'Error al desactivar')
    }
  }

  const perfById = Object.fromEntries(perf.map(p => [p.staffId, p]))
  const activeStaff = staff.filter(s => s.active)
  const inactiveStaff = staff.filter(s => !s.active)

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Cajeros y QR personales</h1>
            <p className="text-sm text-slate-500 mt-1">Genera un QR personal para cada cajero o promotora. Cada transaccion que entre por su QR se le atribuye.</p>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl font-semibold text-sm hover:bg-emerald-700"
          >
            <MdPersonAdd className="w-5 h-5" />
            Nuevo cajero
          </button>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-12 space-y-6">
        {loading ? (
          <div className="text-center py-12 text-slate-400">Cargando...</div>
        ) : (
          <>
            {/* Performance Ranking */}
            {perf.length > 0 && (
              <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
                <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                  <MdBarChart className="w-5 h-5 text-emerald-600" />
                  <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Ranking ultimos 30 dias</h2>
                </div>
                <div className="divide-y divide-slate-50">
                  {perf.map((p, i) => (
                    <div key={p.staffId} className="px-5 py-3 flex items-center gap-4">
                      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                        i === 0 ? 'bg-amber-100 text-amber-700' :
                        i === 1 ? 'bg-slate-100 text-slate-700' :
                        i === 2 ? 'bg-orange-100 text-orange-700' :
                        'bg-slate-50 text-slate-500'
                      }`}>
                        {i + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800 truncate">{p.staffName}</p>
                        <p className="text-xs text-slate-500 capitalize">{p.staffRole}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-emerald-700 tabular-nums">{p.transactions}</p>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">trx</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-slate-800 tabular-nums">{p.uniqueConsumers}</p>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">clientes</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-indigo-700 tabular-nums">{formatPoints(p.valueIssued)}</p>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">pts</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Staff list */}
            <section>
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">Cajeros activos</h2>
              {activeStaff.length === 0 ? (
                <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-500 text-sm">
                  Aun no has creado cajeros. Crea uno para generar su QR personal.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {activeStaff.map(s => {
                    const stats = perfById[s.id]
                    return (
                      <div key={s.id} className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm hover:shadow-md transition">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-slate-800 truncate">{s.name}</p>
                            <p className="text-xs text-slate-500 truncate">{s.email}</p>
                            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                              <span className="inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                {s.role}
                              </span>
                              {s.role === 'cashier' && s.branchId && (
                                <span className="inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                                  {branches.find(b => b.id === s.branchId)?.name || 'Sucursal'}
                                </span>
                              )}
                              {s.role === 'cashier' && !s.branchId && (
                                <span className="inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                                  {tenantName} (sede principal)
                                </span>
                              )}
                            </div>
                            {s.role === 'cashier' && (
                              s.branchLocked ? (
                                <p className="text-[11px] text-slate-400 mt-1.5">Sucursal bloqueada. Para otro cambio, comunicate con soporte@valee.app.</p>
                              ) : (
                                <button
                                  onClick={() => setBranchEdit({ staff: s, branchId: s.branchId || '' })}
                                  className="text-[11px] text-emerald-700 hover:underline mt-1.5"
                                >
                                  Cambiar sucursal (1 vez)
                                </button>
                              )
                            )}
                          </div>
                          {s.role === 'cashier' && (
                            <button
                              onClick={() => handleDeactivate(s)}
                              className="text-xs text-red-600 hover:text-red-700 hover:underline"
                            >
                              Desactivar
                            </button>
                          )}
                        </div>

                        {stats && (
                          <div className="grid grid-cols-3 gap-2 mb-4 text-center">
                            <div className="bg-slate-50 rounded-lg py-2">
                              <p className="font-bold text-slate-800 text-sm tabular-nums">{stats.transactions}</p>
                              <p className="text-[10px] text-slate-500 uppercase">Trx</p>
                            </div>
                            <div className="bg-slate-50 rounded-lg py-2">
                              <p className="font-bold text-slate-800 text-sm tabular-nums">{stats.uniqueConsumers}</p>
                              <p className="text-[10px] text-slate-500 uppercase">Clientes</p>
                            </div>
                            <div className="bg-slate-50 rounded-lg py-2">
                              <p className="font-bold text-indigo-700 text-sm tabular-nums">{formatPoints(stats.valueIssued)}</p>
                              <p className="text-[10px] text-slate-500 uppercase">Pts</p>
                            </div>
                          </div>
                        )}

                        {s.qrCodeUrl ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => setQrPreview({ name: s.name, url: s.qrCodeUrl! })}
                              className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-50 text-emerald-700 px-3 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-100"
                            >
                              <MdQrCode2 className="w-4 h-4" />
                              Ver QR
                            </button>
                            <button
                              onClick={() => handleGenerate(s.id)}
                              disabled={generating === s.id || s.qrRegenLocked}
                              className="inline-flex items-center justify-center gap-1 bg-white border border-slate-200 text-slate-600 px-3 py-2.5 rounded-xl text-sm font-semibold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                              title={s.qrRegenLocked
                                ? 'Ya regeneraste este QR 2 veces. Contacta soporte@valee.app.'
                                : `Regenerar (${s.qrRegenCount || 0}/${s.qrRegenCap || 2}) — invalida el anterior e invita a un cambio de razon.`}
                            >
                              {generating === s.id
                                ? '...'
                                : s.qrRegenLocked
                                  ? 'Bloqueado'
                                  : `Regenerar (${s.qrRegenCount || 0}/${s.qrRegenCap || 2})`}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleGenerate(s.id)}
                            disabled={generating === s.id}
                            className="w-full inline-flex items-center justify-center gap-2 bg-emerald-600 text-white px-3 py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                          >
                            <MdQrCode2 className="w-4 h-4" />
                            {generating === s.id ? 'Generando...' : 'Generar QR'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {inactiveStaff.length > 0 && (
              <section>
                <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2 px-1">Inactivos</h2>
                <div className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-50">
                  {inactiveStaff.map(s => (
                    <div key={s.id} className="px-5 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-600">{s.name}</p>
                        <p className="text-xs text-slate-400">{s.email}</p>
                      </div>
                      <span className="text-[11px] text-slate-400 uppercase tracking-wide">Desactivado</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {/* Add staff modal */}
      {showAddForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800">Nuevo cajero</h3>
              <button onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-slate-600">
                <MdClose className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Nombre</label>
                <input
                  required
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="Juan Perez"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Email</label>
                <input
                  required type="email"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="juan@comercio.com"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Contrasena temporal</label>
                <input
                  required type="text" minLength={6}
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="min. 6 caracteres"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Rol</label>
                <select
                  value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value as any })}
                  className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="cashier">Cajero</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              {form.role === 'cashier' && (
                <div>
                  <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Sucursal</label>
                  <select
                    value={form.branchId}
                    onChange={e => setForm({ ...form, branchId: e.target.value })}
                    className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="">{tenantName} (sede principal)</option>
                    {branches.filter(b => b.active).map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-500 mt-1">Sede principal = tu local original. La sucursal solo se puede cambiar una vez despues de crear al cajero.</p>
                </div>
              )}
              {addError && <p className="text-sm text-red-600">{addError}</p>}
              <button
                type="submit"
                disabled={addSubmitting}
                className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50 mt-2"
              >
                {addSubmitting ? 'Creando...' : 'Crear cajero'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Branch change modal */}
      {branchEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800">Cambiar sucursal de {branchEdit.staff.name}</h3>
              <button onClick={() => { setBranchEdit(null); setBranchEditError('') }} className="text-slate-400 hover:text-slate-600">
                <MdClose className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-3">
              Solo puedes cambiar la sucursal una vez. Despues, cualquier otro cambio requiere contactar a soporte@valee.app.
            </p>
            <form onSubmit={handleBranchEdit} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Nueva sucursal</label>
                <select
                  value={branchEdit.branchId}
                  onChange={e => setBranchEdit({ ...branchEdit, branchId: e.target.value })}
                  className="w-full mt-1 px-3 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">Sede principal (tu local)</option>
                  {branches.filter(b => b.active).map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              {branchEditError && <p className="text-sm text-red-600">{branchEditError}</p>}
              <button
                type="submit"
                disabled={
                  branchEditSubmitting
                  || (branchEdit.branchId || null) === (branchEdit.staff.branchId || null)
                }
                className="w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50 mt-2"
              >
                {branchEditSubmitting ? 'Guardando...' : 'Confirmar cambio'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* QR preview modal */}
      {qrPreview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={() => setQrPreview(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 text-center" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800">QR de {qrPreview.name}</h3>
              <button onClick={() => setQrPreview(null)} className="text-slate-400 hover:text-slate-600">
                <MdClose className="w-5 h-5" />
              </button>
            </div>
            <img src={qrPreview.url} alt={`QR de ${qrPreview.name}`} className="w-full rounded-xl mb-4" />
            <p className="text-xs text-slate-500 mb-4">
              Imprime este QR y ponlo en la zona de trabajo de {qrPreview.name}. Cuando un cliente lo escanee, la siguiente transaccion se le atribuye.
            </p>
            <a
              href={qrPreview.url}
              download={`qr-${qrPreview.name.replace(/\s+/g, '-').toLowerCase()}.png`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-emerald-700"
            >
              <MdDownload className="w-4 h-4" />
              Descargar
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
