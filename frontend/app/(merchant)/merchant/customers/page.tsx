'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { MdPeople, MdSearch, MdVerified, MdPerson } from 'react-icons/md'

interface Customer {
  id: string
  phoneNumber: string
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
    try {
      const data = await api.lookupCustomer(phone)
      setSelected(data)
    } catch {}
    setSelectedLoading(false)
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
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Clientes</h1>
        <p className="text-sm text-slate-500 mt-1">{total} clientes registrados</p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Search */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-6 max-w-xl">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar por telefono o cedula..."
                value={search}
                onChange={e => { setSearch(e.target.value); setOffset(0) }}
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Customer List */}
          <div className="lg:col-span-2">
            {loading ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
                <p className="text-slate-400">Cargando...</p>
              </div>
            ) : customers.length === 0 ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
                <MdPeople className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-400">{search ? 'Sin resultados para esta busqueda' : 'Aun no hay clientes registrados'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {customers.map(c => (
                  <button
                    key={c.id}
                    onClick={() => selectCustomer(c.phoneNumber)}
                    className={`w-full text-left bg-white rounded-xl p-4 shadow-sm border transition hover:shadow-md hover:border-emerald-200 ${
                      selected?.account?.id === c.id ? 'border-emerald-400 ring-1 ring-emerald-400' : 'border-slate-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          c.accountType === 'verified' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {c.accountType === 'verified' ? <MdVerified className="w-5 h-5" /> : <MdPerson className="w-5 h-5" />}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 text-sm">{c.phoneNumber}</p>
                          <p className="text-xs text-slate-400">
                            {c.invoiceCount} factura{c.invoiceCount !== 1 ? 's' : ''}
                            {c.cedula && ` · ${c.cedula}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-emerald-700 text-sm">{parseFloat(c.balance).toLocaleString()}</p>
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
              <div className="space-y-4 sticky top-4">
                {/* Account Card */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cliente</p>
                      <p className="text-lg font-bold text-slate-800 mt-1">{selected.account.phoneNumber}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                      selected.account.accountType === 'verified' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {selected.account.accountType === 'verified' ? 'Verificada' : 'Shadow'}
                    </span>
                  </div>
                  {selected.account.cedula && (
                    <p className="text-sm text-slate-600">Cedula: {selected.account.cedula}</p>
                  )}
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Saldo</p>
                    <p className="text-3xl font-bold text-emerald-700 mt-1">{parseFloat(selected.balance).toLocaleString()}</p>
                  </div>

                  {/* Identity upgrade */}
                  {selected.account.accountType === 'shadow' && (
                    <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                      <input
                        type="text"
                        placeholder="Cedula (V-12345678)"
                        value={cedula}
                        onChange={e => { setCedula(e.target.value); setConflictPhone(null) }}
                        className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                          className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
                        >Verificar identidad</button>
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
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {selected.invoices.map((inv: any) => (
                        <div key={inv.id} className="flex justify-between items-center py-1.5 border-b border-slate-50 last:border-0">
                          <span className="text-sm text-slate-700 truncate mr-2">{inv.invoiceNumber}</span>
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-semibold">{parseFloat(inv.amount).toLocaleString()}</p>
                            <span className={`text-xs ${inv.status === 'claimed' ? 'text-green-600' : inv.status === 'available' ? 'text-blue-500' : 'text-amber-500'}`}>{inv.status}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* History */}
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                  <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-3">Movimientos</p>
                  {!selected.history?.length ? (
                    <p className="text-sm text-slate-400">Sin movimientos</p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {selected.history.map((e: any) => (
                        <div key={e.id} className="flex justify-between items-center py-1.5 border-b border-slate-50 last:border-0">
                          <span className="text-xs text-slate-600 truncate mr-2">{e.eventType}</span>
                          <span className={`text-sm font-semibold ${e.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
                            {e.entryType === 'CREDIT' ? '+' : '-'}{parseFloat(e.amount).toLocaleString()}
                          </span>
                        </div>
                      ))}
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
