'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadDisputes() }, [])

  async function loadDisputes() {
    try {
      // For now, disputes are loaded from the API when the route is built
      // This is a placeholder — the API route needs to be added
      setDisputes([])
    } catch {} finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen bg-emerald-50 p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/merchant" className="text-emerald-700 text-2xl">&larr;</Link>
        <h1 className="text-xl font-bold text-emerald-800">Disputas</h1>
      </div>

      {loading ? (
        <p className="text-center text-slate-400 mt-8">Cargando...</p>
      ) : disputes.length === 0 ? (
        <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
          <span className="text-4xl">📋</span>
          <p className="text-slate-500 mt-3">No hay disputas pendientes</p>
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map((d: any) => (
            <div key={d.id} className="bg-white rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="font-medium text-sm">{d.description?.slice(0, 50)}...</p>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  d.status === 'open' ? 'bg-amber-100 text-amber-700' :
                  d.status === 'approved' ? 'bg-green-100 text-green-700' :
                  d.status === 'rejected' ? 'bg-red-100 text-red-700' :
                  'bg-blue-100 text-blue-700'
                }`}>{d.status}</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">{new Date(d.createdAt).toLocaleString('es-VE')}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
