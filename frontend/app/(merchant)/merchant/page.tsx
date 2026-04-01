'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export default function MerchantDashboard() {
  const [role, setRole] = useState('')
  const [staffName, setStaffName] = useState('')
  const [analytics, setAnalytics] = useState<any>(null)
  const router = useRouter()

  useEffect(() => {
    const r = localStorage.getItem('staffRole')
    const n = localStorage.getItem('staffName')
    if (!r) { router.push('/merchant/login'); return }
    setRole(r)
    setStaffName(n || '')
    if (r === 'cashier') { router.push('/merchant/scanner'); return }
    loadAnalytics()
  }, [router])

  async function loadAnalytics() {
    try { setAnalytics(await api.getAnalytics()) } catch {}
  }

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('staffRole')
    localStorage.removeItem('staffName')
    router.push('/merchant/login')
  }

  if (role === 'cashier') return null

  return (
    <div className="min-h-screen bg-emerald-50">
      <div className="bg-emerald-700 text-white p-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Dashboard</h1>
          <p className="text-emerald-200 text-sm">{staffName} (owner)</p>
        </div>
        <button onClick={logout} className="text-sm text-emerald-200 hover:text-white">Salir</button>
      </div>

      {/* Metrics Cards */}
      {analytics && (
        <div className="grid grid-cols-2 gap-3 p-4">
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Valor emitido</p>
            <p className="text-xl font-bold text-emerald-700">{parseFloat(analytics.valueIssued).toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Valor canjeado</p>
            <p className="text-xl font-bold text-emerald-700">{parseFloat(analytics.valueRedeemed).toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">En circulacion</p>
            <p className="text-xl font-bold text-indigo-600">{parseFloat(analytics.netBalance).toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Consumidores</p>
            <p className="text-xl font-bold">{analytics.consumerCount}</p>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="p-4 space-y-3">
        <Link href="/merchant/scanner" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">📷 Escaner QR</p>
          <p className="text-xs text-slate-500">Escanear codigos de canje de clientes</p>
        </Link>
        <Link href="/merchant/products" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">📦 Catalogo de productos</p>
          <p className="text-xs text-slate-500">Agregar, editar y gestionar productos</p>
        </Link>
        <Link href="/merchant/customers" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">👥 Buscar cliente</p>
          <p className="text-xs text-slate-500">Consultar cuentas y vincular cedula</p>
        </Link>
        <Link href="/merchant/disputes" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">📋 Disputas</p>
          <p className="text-xs text-slate-500">Resolver reclamos de clientes</p>
        </Link>
      </div>
    </div>
  )
}
