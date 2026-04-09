'use client'

import { useState } from 'react'
import { api } from '@/lib/api'

export default function CustomerLookup() {
  const [phone, setPhone] = useState('')
  const [customer, setCustomer] = useState<any>(null)
  const [error, setError] = useState('')
  const [cedula, setCedula] = useState('')
  const [upgradeMsg, setUpgradeMsg] = useState('')
  const [showUpgrade, setShowUpgrade] = useState(false)

  async function handleSearch() {
    setError('')
    setCustomer(null)
    try {
      const data = await api.lookupCustomer(phone)
      setCustomer(data)
    } catch (e: any) {
      setError(e.error || 'Cliente no encontrado')
    }
  }

  async function handleUpgrade() {
    setUpgradeMsg('')
    try {
      await api.upgradeIdentity(phone, cedula)
      setUpgradeMsg('Cuenta verificada exitosamente')
      setShowUpgrade(false)
      handleSearch()
    } catch (e: any) {
      if (e.requiresConfirmation) {
        setUpgradeMsg(`Advertencia: esta cedula ya esta vinculada a ${e.existingPhone}`)
      } else {
        setUpgradeMsg(e.error || 'Error al verificar')
      }
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Page header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <h1 className="text-2xl lg:text-3xl font-bold text-slate-800">Buscar cliente</h1>
        <p className="text-sm text-slate-500 mt-1">Consulta el estado, historial y facturas de un cliente por su telefono</p>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 pb-8">
        {/* Search box */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 mb-6 max-w-2xl">
          <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Numero de telefono</label>
          <div className="flex gap-2 mt-2">
            <input
              type="tel"
              placeholder="+58412..."
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1 px-4 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              onClick={handleSearch}
              className="bg-emerald-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-700 transition"
            >
              Buscar
            </button>
          </div>
          {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
        </div>

        {customer && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Account card */}
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
              <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
                <div>
                  <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Cliente</p>
                  <p className="text-lg font-bold text-slate-800 mt-1">{customer.account.phoneNumber}</p>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                  customer.account.accountType === 'verified'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-slate-100 text-slate-600'
                }`}>
                  {customer.account.accountType === 'verified' ? 'Verificada' : 'Shadow'}
                </span>
              </div>

              <div className="space-y-2 text-sm">
                {customer.account.cedula && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Cedula</span>
                    <span className="text-slate-800 font-medium">{customer.account.cedula}</span>
                  </div>
                )}
                {customer.account.level > 1 && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Nivel</span>
                    <span className="text-slate-800 font-medium">Nivel {customer.account.level}</span>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Saldo de puntos</p>
                <p className="text-3xl lg:text-4xl font-bold text-emerald-700 mt-1">
                  {parseFloat(customer.balance).toLocaleString()}
                </p>
              </div>

              {/* Identity upgrade */}
              {customer.account.accountType === 'shadow' && !showUpgrade && (
                <button
                  onClick={() => setShowUpgrade(true)}
                  className="w-full mt-4 bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition"
                >
                  Verificar identidad
                </button>
              )}

              {showUpgrade && (
                <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                  <input
                    type="text"
                    placeholder="Cedula (V-12345678)"
                    value={cedula}
                    onChange={e => setCedula(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowUpgrade(false)}
                      className="flex-1 bg-slate-100 py-2.5 rounded-lg text-sm hover:bg-slate-200 transition"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={handleUpgrade}
                      disabled={!cedula}
                      className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700 transition"
                    >
                      Vincular
                    </button>
                  </div>
                </div>
              )}

              {upgradeMsg && (
                <p className={`text-sm mt-3 ${upgradeMsg.includes('exitosamente') ? 'text-green-600' : 'text-amber-600'}`}>
                  {upgradeMsg}
                </p>
              )}
            </div>

            {/* Invoices card */}
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-4">Facturas</p>
              {!customer.invoices || customer.invoices.length === 0 ? (
                <p className="text-sm text-slate-400">Sin facturas</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {customer.invoices.map((inv: any) => (
                    <div key={inv.id} className="flex justify-between items-center py-2 border-b border-slate-50 last:border-0">
                      <span className="text-sm text-slate-700 truncate mr-2">{inv.invoiceNumber}</span>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-slate-800">
                          {parseFloat(inv.amount).toLocaleString()}
                        </p>
                        <span className={`text-xs ${
                          inv.status === 'claimed' ? 'text-green-600' :
                          inv.status === 'available' ? 'text-blue-500' :
                          'text-amber-500'
                        }`}>
                          {inv.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* History card */}
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-4">Historial de puntos</p>
              {customer.history.length === 0 ? (
                <p className="text-sm text-slate-400">Sin movimientos</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {customer.history.map((e: any) => (
                    <div key={e.id} className="flex justify-between items-center py-2 border-b border-slate-50 last:border-0">
                      <span className="text-xs text-slate-600 truncate mr-2">{e.eventType}</span>
                      <span className={`text-sm font-semibold flex-shrink-0 ${e.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}`}>
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
  )
}
