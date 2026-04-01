'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState<any>(null)
  const [tenants, setTenants] = useState<any[]>([])
  const [adminName, setAdminName] = useState('')
  const router = useRouter()

  useEffect(() => {
    const name = localStorage.getItem('adminName')
    if (!name) { router.push('/admin/login'); return }
    setAdminName(name)
    loadData()
  }, [router])

  async function loadData() {
    try {
      const [m, t] = await Promise.all([api.getMetrics(), api.getTenants()])
      setMetrics(m)
      setTenants(t.tenants)
    } catch {
      router.push('/admin/login')
    }
  }

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('adminName')
    router.push('/admin/login')
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="bg-slate-900 text-white p-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Admin Panel</h1>
          <p className="text-slate-400 text-sm">{adminName}</p>
        </div>
        <button onClick={logout} className="text-sm text-slate-400 hover:text-white">Logout</button>
      </div>

      {/* Metrics */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Active Tenants</p>
            <p className="text-2xl font-bold">{metrics.activeTenants}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Total Consumers</p>
            <p className="text-2xl font-bold">{metrics.totalConsumers}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Value in Circulation</p>
            <p className="text-2xl font-bold">{parseFloat(metrics.totalValueInCirculation).toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Validations (30d)</p>
            <p className="text-2xl font-bold">{metrics.validationsLast30Days}</p>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="p-4 space-y-3">
        <Link href="/admin/tenants" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">🏪 Tenant Management</p>
          <p className="text-xs text-slate-500">Create, view, and deactivate merchants</p>
        </Link>
        <Link href="/admin/ledger" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">📒 Global Ledger Audit</p>
          <p className="text-xs text-slate-500">View and verify ledger across all tenants</p>
        </Link>
        <Link href="/admin/adjustments" className="block bg-white rounded-xl p-4 shadow-sm hover:shadow-md transition">
          <p className="font-medium">⚖️ Manual Adjustments</p>
          <p className="text-xs text-slate-500">Apply manual corrections to consumer accounts</p>
        </Link>
      </div>

      {/* Tenants List */}
      <div className="p-4">
        <h2 className="font-semibold mb-3">Tenants ({tenants.length})</h2>
        <div className="space-y-2">
          {tenants.map(t => (
            <div key={t.id} className="bg-white rounded-xl p-4 shadow-sm flex items-center justify-between">
              <div>
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-slate-500">{t.slug} | {t.ownerEmail}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {t.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
