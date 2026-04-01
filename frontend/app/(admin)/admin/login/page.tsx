'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { useRouter } from 'next/navigation'

export default function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin() {
    setError('')
    setLoading(true)
    try {
      const data = await api.adminLogin(email, password)
      localStorage.setItem('accessToken', data.accessToken)
      localStorage.setItem('adminName', data.admin.name)
      router.push('/admin')
    } catch (e: any) {
      setError(e.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-100">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-800">Admin Panel</h1>
          <p className="text-slate-500 mt-1">Platform administration</p>
        </div>
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-400" />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-400" />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button onClick={handleLogin} disabled={loading} className="w-full bg-slate-800 text-white py-3 rounded-xl font-medium hover:bg-slate-900 disabled:opacity-50 transition">
            {loading ? 'Logging in...' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  )
}
