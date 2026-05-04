'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { MdPeople, MdSearch, MdVerified, MdPerson } from 'react-icons/md'
import { formatPoints, formatCash } from '@/lib/format'

interface Customer {
  id: string
  phoneNumber: string
  displayName: string | null
  accountType: string
  cedula: string | null
  level: number
  balance: string
  invoiceCount: number
  lastInvoice: { invoiceNumber: string; amount: string; status: string; date: string } | null
  createdAt: string
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [unitLabel, setUnitLabel] = useState('pts')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)

  // Detail panel
  const [selected, setSelected] = useState<any>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [cedula, setCedula] = useState('')
  const [upgradeMsg, setUpgradeMsg] = useState('')
  const [conflictPhone, setConflictPhone] = useState<string | null>(null)

  // Edit mode
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<{ displayName: string; cedula: string }>({ displayName: '', cedula: '' })
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState('')
  const [editConflict, setEditConflict] = useState<string | null>(null)

  // Expanded rows in FACTURAS / MOVIMIENTOS — show OCR'd line items.
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null)
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null)

  useEffect(() => { loadCustomers() }, [offset, search])

  async function loadCustomers() {
    setLoading(true)
    try {
      const data = await api.getCustomers({ limit: 50, offset, search: search || undefined })
      setCustomers(data.customers)
      setTotal(data.total)
      setUnitLabel(data.unitLabel)
    } catch {}
    setLoading(false)
  }

  async function selectCustomer(phone: string) {
    setSelectedLoading(true)
    setSelected(null)
    setUpgradeMsg('')
    setConflictPhone(null)
    setCedula('')
    setEditing(false)
    setEditMsg('')
    setEditConflict(null)
    try {
      const data = await api.lookupCustomer(phone)
      setSelected(data)
      setEditForm({ displayName: data.account.displayName || '', cedula: data.account.cedula || '' })
    } catch {}
    setSelectedLoading(false)
  }

  async function handleSaveEdit(force = false) {
    if (!selected) return
    setEditSaving(true)
    setEditMsg('')
    try {
      const payload: { displayName?: string | null; cedula?: string | null } = {}
      const name = editForm.displayName.trim()
      const ced = editForm.cedula.trim()
      payload.displayName = name || null
      payload.cedula = ced || null
      const res = await api.updateCustomer(selected.account.id, payload)
      setSelected({ ...selected, account: { ...selected.account, ...res.account } })
      setEditMsg('Cambios guardados')
      setEditConflict(null)
      setEditing(false)
      loadCustomers()
    } catch (e: any) {
      if (e.existingPhone) {
        setEditConflict(e.existingPhone)
        setEditMsg('')
      } else {
        setEditMsg(e.error || e.message || 'Error al guardar')
      }
    }
    setEditSaving(false)
  }

  async function handleUpgrade(force = false) {
    if (!selected) return
    setUpgradeMsg('')
    try {
      await api.upgradeIdentity(selected.account.phoneNumber, cedula, force)
      setUpgradeMsg('Cuenta verificada exitosamente')
      setConflictPhone(null)
      setCedula('')
      selectCustomer(selected.account.phoneNumber)
      loadCustomers()
    } catch (e: any) {
      if (e.requiresConfirmation && e.existingPhone) {
        setConflictPhone(e.existingPhone)
      } else {
        setUpgradeMsg(e.error || 'Error al verificar')
      }
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4 aa-rise">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Clientes</h1>
        <p className="text-sm text-slate-500 mt-1"><span key={total} className="aa-count inline-block tabular-nums">{total}</span> clientes registrados</p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Search */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-6 max-w-xl aa-rise" style={{ animationDelay: '80ms' }}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar por telefono o cedula..."
                value={search}
                onChange={e => { setSearch(e.target.value); setOffset(0) }}
                className="aa-field aa-field-emerald w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Customer List */}
          <div className="lg:col-span-2">
            {loading ? (
              <div className="space-y-2">
                {[0,1,2,3,4].map(i => (
                  <div key={i} className="bg-white rounded-xl p-4 border border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div className="aa-skel w-10 h-10 rounded-full" />
                      <div className="space-y-2 flex-1">
                        <div className="aa-skel h-3 w-1/3" />
                        <div className="aa-skel h-2 w-1/4" />
                      </div>
                    </div>
                    <div className="aa-skel h-5 w-16" />
                  </div>
                ))}
              </div>
            ) : customers.length === 0 ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-100 aa-rise">
                <MdPeople className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-400">{search ? 'Sin resultados para esta busqueda' : 'Aun no hay clientes registrados'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {customers.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => selectCustomer(c.phoneNumber)}
                    className={`aa-card aa-row-in w-full text-left bg-white rounded-xl p-4 shadow-sm border ${
                      selected?.account?.id === c.id ? 'border-emerald-400 ring-1 ring-emerald-400' : 'border-slate-100'
                    }`}
                    style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          c.accountType === 'verified' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {c.accountType === 'verified' ? <MdVerified className="w-5 h-5" /> : <MdPerson className="w-5 h-5" />}
                        </div>
                        <div className="min-w-0">
                          {c.displayName ? (
                            <>
                              <p className="font-semibold text-slate-800 text-sm truncate">{c.displayName}</p>
                              <p className="text-xs text-slate-500 truncate">{c.phoneNumber}</p>
                            </>
                          ) : (
                            <p className="font-semibold text-slate-800 text-sm truncate">{c.phoneNumber}</p>
                          )}
                          <p className="text-xs text-slate-400">
                            {c.invoiceCount} factura{c.invoiceCount !== 1 ? 's' : ''}
                            {c.cedula && ` · ${c.cedula}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-emerald-700 text-sm">{formatPoints(c.balance)}</p>
                        <p className="text-[10px] text-slate-400">{unitLabel}</p>
                      </div>
                    </div>
                  </button>
                ))}

                {/* Pagination */}
                {total > 50 && (
                  <div className="flex justify-center gap-3 pt-4">
                    <button
                      onClick={() => setOffset(Math.max(0, offset - 50))}
                      disabled={offset === 0}
                      className="px-4 py-2 rounded-lg text-sm bg-white border border-slate-200 disabled:opacity-40"
                    >Anterior</button>
                    <span className="px-4 py-2 text-sm text-slate-500">{offset + 1}-{Math.min(offset + 50, total)} de {total}</span>
                    <button
                      onClick={() => setOffset(offset + 50)}
                      disabled={offset + 50 >= total}
                      className="px-4 py-2 rounded-lg text-sm bg-white border border-slate-200 disabled:opacity-40"
                    >Siguiente</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Detail Panel */}
          <div>
            {selectedLoading && (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
                <p className="text-slate-400">Cargando detalle...</p>
              </div>
            )}

            {selected && !selectedLoading && (
              <div key={selected.account.id} className="space-y-4 sticky top-4 aa-rise">
                {/* Account Card */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cliente</p>
                      <p className="text-lg font-bold text-slate-800 mt-1 truncate">{selected.account.phoneNumber}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold flex-shrink-0 ml-2 ${
                      selected.account.accountType === 'verified' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {selected.account.accountType === 'verified' ? 'Verificada' : 'Shadow'}
                    </span>
                  </div>

                  {editing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
                        <input
                          type="text"
                          placeholder="Nombre del cliente"
                          value={editForm.displayName}
                          onChange={e => { setEditForm({ ...editForm, displayName: e.target.value }); setEditConflict(null) }}
                          className="aa-field aa-field-emerald w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cedula</label>
                        <input
                          type="text"
                          placeholder="V-12345678"
                          value={editForm.cedula}
                          onChange={e => { setEditForm({ ...editForm, cedula: e.target.value }); setEditConflict(null) }}
                          className="aa-field aa-field-emerald w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      {editConflict && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                          Esta cedula ya esta vinculada a {editConflict}. Cambia la cedula o desvinculala desde el otro cliente primero.
                        </div>
                      )}
                      {editMsg && <p className={`text-sm ${editMsg.includes('guardados') ? 'text-green-600' : 'text-red-500'}`}>{editMsg}</p>}
                      <div className="flex gap-2">
                        <button onClick={() => { setEditing(false); setEditMsg(''); setEditConflict(null); setEditForm({ displayName: selected.account.displayName || '', cedula: selected.account.cedula || '' }) }} className="flex-1 bg-slate-100 py-2 rounded-lg text-sm">Cancelar</button>
                        <button onClick={() => handleSaveEdit()} disabled={editSaving} className="aa-btn aa-btn-emerald flex-1 bg-emerald-600 text-white py-2 rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center justify-center">
                          {editSaving && <span className="aa-spinner" />}<span className="relative z-10">{editSaving ? 'Guardando...' : 'Guardar'}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {selected.account.displayName && (
                        <p className="text-sm text-slate-600">Nombre: {selected.account.displayName}</p>
                      )}
                      {selected.account.cedula && (
                        <p className="text-sm text-slate-600">Cedula: {selected.account.cedula}</p>
                      )}
                      <button
                        onClick={() => setEditing(true)}
                        className="mt-3 text-xs text-emerald-600 hover:text-emerald-800 font-semibold"
                      >
                        Editar datos
                      </button>
                    </>
                  )}

                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Saldo</p>
                    <p className="text-3xl font-bold text-emerald-700 mt-1">{formatPoints(selected.balance)}</p>
                  </div>

                  {/* Identity upgrade */}
                  {selected.account.accountType === 'shadow' && (
                    <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                      <input
                        type="text"
                        placeholder="Cedula (V-12345678)"
                        value={cedula}
                        onChange={e => { setCedula(e.target.value); setConflictPhone(null) }}
                        className="aa-field w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                      />
                      {conflictPhone ? (
                        <div className="space-y-2">
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                            <p className="text-xs text-amber-800">Esta cedula esta vinculada a {conflictPhone}. Confirmar reasignara.</p>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => setConflictPhone(null)} className="flex-1 bg-slate-100 py-2 rounded-lg text-sm">Cancelar</button>
                            <button onClick={() => handleUpgrade(true)} className="flex-1 bg-amber-600 text-white py-2 rounded-lg text-sm font-semibold">Reasignar</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleUpgrade(false)}
                          disabled={!cedula}
                          className="aa-btn aa-btn-primary w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
                        ><span className="relative z-10">Verificar identidad</span></button>
                      )}
                      {upgradeMsg && <p className={`text-sm ${upgradeMsg.includes('exitosamente') ? 'text-green-600' : 'text-amber-600'}`}>{upgradeMsg}</p>}
                    </div>
                  )}
                </div>

                {/* Invoices */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                  <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-3">Facturas</p>
                  {!selected.invoices?.length ? (
                    <p className="text-sm text-slate-400">Sin facturas</p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {selected.invoices.map((inv: any) => {
                        const hasItems = Array.isArray(inv.items) && inv.items.length > 0
                        const isOpen = expandedInvoiceId === inv.id
                        return (
                          <div key={inv.id} className="border-b border-slate-50 last:border-0">
                            <button
                              type="button"
                              onClick={() => hasItems && setExpandedInvoiceId(isOpen ? null : inv.id)}
                              className={`w-full flex justify-between items-start gap-2 py-2 text-left ${hasItems ? 'cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded' : ''}`}
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-slate-700 font-mono truncate">{inv.invoiceNumber}</p>
                                <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
                                  {inv.uploadedAt && <span>Subida: {new Date(inv.uploadedAt).toLocaleDateString('es-VE')}</span>}
                                  {inv.branch?.name && <span>· {inv.branch.name}</span>}
                                  {hasItems && <span className="text-indigo-500">· {isOpen ? 'Ocultar items' : `${inv.items.length} item${inv.items.length === 1 ? '' : 's'}`}</span>}
                                </div>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="text-sm font-semibold">
                                  {inv.amountInReference
                                    ? `${inv.currencySymbol || '$'}${formatCash(inv.amountInReference)}`
                                    : `Bs ${formatCash(inv.amount)}`}
                                </p>
                                <span className={`text-[11px] font-semibold ${inv.status === 'claimed' ? 'text-green-600' : inv.status === 'available' ? 'text-blue-500' : 'text-amber-500'}`}>{
                                  inv.status === 'available' ? 'No reclamada'
                                  : inv.status === 'claimed' ? 'Canjeada'
                                  : inv.status === 'pending_validation' ? 'En validacion'
                                  : inv.status === 'rejected' ? 'Rechazada'
                                  : inv.status
                                }</span>
                              </div>
                            </button>
                            {isOpen && hasItems && (
                              <div className="ml-1 mb-2 mt-1 border-l-2 border-indigo-100 pl-3 space-y-1">
                                {inv.items.map((it: any, idx: number) => (
                                  <div key={idx} className="flex justify-between text-xs text-slate-600">
                                    <span className="truncate flex-1">{it.quantity > 1 ? `${it.quantity}× ` : ''}{it.name}</span>
                                    {it.unitPrice > 0 && (
                                      <span className="text-slate-400 ml-2">Bs {formatCash(String(it.unitPrice * it.quantity))}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* History */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                  <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-3">Movimientos</p>
                  {!selected.history?.length ? (
                    <p className="text-sm text-slate-400">Sin movimientos</p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {selected.history.map((e: any) => {
                        const hasItems = Array.isArray(e.items) && e.items.length > 0
                        const isOpen = expandedHistoryId === e.id
                        const expandable = hasItems
                        return (
                          <div key={e.id} className="border-b border-slate-50 last:border-0">
                            <button
                              type="button"
                              onClick={() => expandable && setExpandedHistoryId(isOpen ? null : e.id)}
                              className={`w-full flex justify-between items-start gap-2 py-2 text-left ${expandable ? 'cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded' : ''}`}
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-slate-700 truncate">{e.label || e.eventType}</p>
                                {e.subtitle && (
                                  <p className="text-xs text-slate-500 truncate mt-0.5">{e.subtitle}</p>
                                )}
                                <div className="text-[10px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
                                  <span>{new Date(e.createdAt).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })}</span>
                                  {e.branchName && <span className="text-indigo-600">· {e.branchName}</span>}
                                  {hasItems && <span className="text-indigo-500">· {isOpen ? 'Ocultar items' : `${e.items.length} item${e.items.length === 1 ? '' : 's'}`}</span>}
                                </div>
                              </div>
                              <span className={`text-sm font-semibold whitespace-nowrap ${e.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                                {e.entryType === 'CREDIT' ? '+' : '-'}{formatPoints(e.amount)}
                              </span>
                            </button>
                            {isOpen && hasItems && (
                              <div className="ml-1 mb-2 mt-1 border-l-2 border-indigo-100 pl-3 space-y-1">
                                {e.items.map((it: any, idx: number) => (
                                  <div key={idx} className="flex justify-between text-xs text-slate-600">
                                    <span className="truncate flex-1">{it.quantity > 1 ? `${it.quantity}× ` : ''}{it.name}</span>
                                    {it.unitPrice > 0 && (
                                      <span className="text-slate-400 ml-2">Bs {formatCash(String(it.unitPrice * it.quantity))}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
