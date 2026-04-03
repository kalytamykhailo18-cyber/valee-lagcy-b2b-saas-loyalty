'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

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
      setError(e.error || 'Customer not found')
    }
  }

  async function handleUpgrade() {
    setUpgradeMsg('')
    try {
      const data = await api.upgradeIdentity(phone, cedula)
      setUpgradeMsg('Cuenta verificada exitosamente!')
      setShowUpgrade(false)
      handleSearch() // Refresh
    } catch (e: any) {
      if (e.requiresConfirmation) {
        setUpgradeMsg(`Advertencia: esta cedula ya esta vinculada a ${e.existingPhone}`)
      } else {
        setUpgradeMsg(e.error || 'Error upgrading')
      }
    }
  }

  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold text-emerald-800">Buscar cliente</h1>
      </div>

      <div className="bg-white rounded-2xl p-4 shadow-sm mb-4">
        <div className="flex gap-2">
          <input type="tel" placeholder="+58412..." value={phone} onChange={e => setPhone(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          <button onClick={handleSearch} className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
            Buscar
          </button>
        </div>
        {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
      </div>

      {customer && (
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{customer.account.phoneNumber}</p>
              <p className="text-sm text-slate-500">
                {customer.account.accountType === 'verified' ? '✅ Verificada' : '👤 Shadow'}
                {customer.account.level > 1 ? ` | Nivel ${customer.account.level}` : ''}
              </p>
              {customer.account.cedula && <p className="text-sm text-slate-500">Cedula: {customer.account.cedula}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Saldo</p>
              <p className="text-xl font-bold text-emerald-700">{parseFloat(customer.balance).toLocaleString()}</p>
            </div>
          </div>

          {/* Upgrade button for shadow accounts */}
          {customer.account.accountType === 'shadow' && !showUpgrade && (
            <button onClick={() => setShowUpgrade(true)}
              className="w-full bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium">
              Verificar identidad
            </button>
          )}

          {showUpgrade && (
            <div className="border-t pt-3 space-y-2">
              <input type="text" placeholder="Cedula (V-12345678)" value={cedula} onChange={e => setCedula(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
              <div className="flex gap-2">
                <button onClick={() => setShowUpgrade(false)} className="flex-1 bg-slate-100 py-2 rounded-lg text-sm">Cancelar</button>
                <button onClick={handleUpgrade} disabled={!cedula} className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                  Vincular cedula
                </button>
              </div>
            </div>
          )}

          {upgradeMsg && <p className={`text-sm ${upgradeMsg.includes('exitosamente') ? 'text-green-600' : 'text-amber-600'}`}>{upgradeMsg}</p>}

          {/* Invoice submission history */}
          {customer.invoices && customer.invoices.length > 0 && (
            <div className="border-t pt-3">
              <p className="text-sm font-medium text-slate-600 mb-2">Facturas</p>
              <div className="space-y-1">
                {customer.invoices.map((inv: any) => (
                  <div key={inv.id} className="flex justify-between text-sm">
                    <span className="text-slate-600">{inv.invoiceNumber}</span>
                    <div className="text-right">
                      <span className="text-slate-700">${parseFloat(inv.amount).toLocaleString()}</span>
                      <span className={`ml-2 text-xs ${inv.status === 'claimed' ? 'text-green-600' : inv.status === 'available' ? 'text-blue-500' : 'text-amber-500'}`}>
                        {inv.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transaction history */}
          <div className="border-t pt-3">
            <p className="text-sm font-medium text-slate-600 mb-2">Historial de puntos</p>
            {customer.history.length === 0 ? (
              <p className="text-xs text-slate-400">Sin movimientos</p>
            ) : (
              <div className="space-y-1">
                {customer.history.map((e: any) => (
                  <div key={e.id} className="flex justify-between text-sm">
                    <span className="text-slate-600">{e.eventType}</span>
                    <span className={e.entryType === 'CREDIT' ? 'text-green-600' : 'text-red-500'}>
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
  )
}
