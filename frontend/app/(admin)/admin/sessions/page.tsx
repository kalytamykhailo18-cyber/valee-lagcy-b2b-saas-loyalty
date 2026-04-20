'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MdArrowBack, MdSearch, MdLogout, MdCheckCircle } from 'react-icons/md'
import { api } from '@/lib/api'

type Kind = 'account' | 'staff'

interface AccountRow {
  id: string
  phoneNumber: string | null
  displayName: string | null
  accountType: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  tokensInvalidatedAt: string | null
  createdAt: string
}

interface StaffRow {
  id: string
  email: string
  name: string
  role: string
  active: boolean
  tenantId: string
  tenantName: string
  tenantSlug: string
  tokensInvalidatedAt: string | null
}

export default function AdminSessionsPage() {
  const router = useRouter()
  const [kind, setKind] = useState<Kind>('account')
  const [query, setQuery] = useState('')
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [lastAction, setLastAction] = useState<string>('')

  useEffect(() => {
    const token = localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) router.push('/admin/login')
  }, [router])

  async function search() {
    if (!query.trim()) return
    setError('')
    setLoading(true)
    setSearched(false)
    try {
      if (kind === 'account') {
        const { accounts } = await api.searchAccounts(query.trim()) as { accounts: AccountRow[] }
        setAccounts(accounts || [])
        setStaff([])
      } else {
        const { staff } = await api.searchStaff(query.trim()) as { staff: StaffRow[] }
        setStaff(staff || [])
        setAccounts([])
      }
      setSearched(true)
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) { router.push('/admin/login'); return }
      setError(e?.error || 'No se pudo realizar la busqueda')
    } finally {
      setLoading(false)
    }
  }

  async function forceLogout(row: { id: string; label: string }, isStaff: boolean) {
    const reason = window.prompt(
      `Confirmar cierre de sesion forzado para ${row.label}.\n\nMotivo (minimo 5 caracteres):`,
      ''
    )
    if (!reason || reason.trim().length < 5) {
      if (reason !== null) alert('El motivo debe tener al menos 5 caracteres.')
      return
    }

    setBusyId(row.id)
    setError('')
    try {
      if (isStaff) await api.forceLogoutStaff(row.id, reason.trim())
      else         await api.forceLogoutAccount(row.id, reason.trim())

      setLastAction(`Sesion cerrada para ${row.label}`)
      // Refresh the list so the "sesion anulada" timestamp shows up.
      await search()
    } catch (e: any) {
      setError(e?.error || 'No se pudo cerrar la sesion')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-4 sm:px-6 lg:px-8 pt-6 lg:pt-8 pb-4">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin" className="text-slate-500 hover:text-slate-700">
            <MdArrowBack className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl lg:text-3xl font-bold text-slate-800 tracking-tight">Sesiones</h1>
        </div>
        <p className="text-sm text-slate-500">
          Busca por telefono (cliente) o email (cajero/dueno) y cierra su sesion al instante.
          La persona va a tener que volver a iniciar sesion con OTP/contrasena.
        </p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-16 space-y-5">
        {/* Kind toggle */}
        <div className="flex bg-white rounded-xl p-1 shadow-sm border border-slate-200 w-fit">
          <button
            onClick={() => { setKind('account'); setSearched(false); }}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${
              kind === 'account' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Cliente (telefono)
          </button>
          <button
            onClick={() => { setKind('staff'); setSearched(false); }}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${
              kind === 'staff' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Staff (email)
          </button>
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-md">
            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder={kind === 'account' ? 'Ej: 04140446569' : 'Ej: owner@comercio.com'}
              className="aa-field aa-field-indigo w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 text-sm"
            />
          </div>
          <button
            onClick={search}
            disabled={loading || !query.trim()}
            className="aa-btn aa-btn-indigo px-5 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold text-sm disabled:opacity-50 hover:bg-indigo-700"
          >
            <span className="relative z-10">{loading ? 'Buscando...' : 'Buscar'}</span>
          </button>
        </div>

        {error && (
          <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
        )}
        {lastAction && (
          <div className="aa-pop bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-800 flex items-center gap-2">
            <MdCheckCircle className="w-4 h-4" />
            {lastAction}
          </div>
        )}

        {/* Accounts results */}
        {kind === 'account' && searched && (
          <section>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">
              Cuentas encontradas ({accounts.length})
            </h2>
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-500 px-1">Sin resultados para {query}.</p>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold">Telefono</th>
                      <th className="text-left px-4 py-2 font-semibold">Nombre</th>
                      <th className="text-left px-4 py-2 font-semibold">Comercio</th>
                      <th className="text-left px-4 py-2 font-semibold">Tipo</th>
                      <th className="text-left px-4 py-2 font-semibold">Sesion anulada</th>
                      <th className="text-right px-4 py-2 font-semibold">Accion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map(a => (
                      <tr key={a.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2 font-mono">{a.phoneNumber || '—'}</td>
                        <td className="px-4 py-2">{a.displayName || <span className="text-slate-400">sin nombre</span>}</td>
                        <td className="px-4 py-2 text-slate-600">{a.tenantName}</td>
                        <td className="px-4 py-2 text-xs">
                          <span className={`px-2 py-0.5 rounded ${a.accountType === 'verified' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                            {a.accountType}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-500">
                          {a.tokensInvalidatedAt ? new Date(a.tokensInvalidatedAt).toLocaleString() : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => forceLogout({ id: a.id, label: `${a.phoneNumber} (${a.tenantName})` }, false)}
                            disabled={busyId === a.id}
                            className="aa-btn inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold disabled:opacity-50 hover:bg-red-700"
                          >
                            <MdLogout className="w-3.5 h-3.5" />
                            <span className="relative z-10">{busyId === a.id ? '...' : 'Cerrar sesion'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Staff results */}
        {kind === 'staff' && searched && (
          <section>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 px-1">
              Staff encontrado ({staff.length})
            </h2>
            {staff.length === 0 ? (
              <p className="text-sm text-slate-500 px-1">Sin resultados para {query}.</p>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold">Email</th>
                      <th className="text-left px-4 py-2 font-semibold">Nombre</th>
                      <th className="text-left px-4 py-2 font-semibold">Comercio</th>
                      <th className="text-left px-4 py-2 font-semibold">Rol</th>
                      <th className="text-left px-4 py-2 font-semibold">Activo</th>
                      <th className="text-left px-4 py-2 font-semibold">Sesion anulada</th>
                      <th className="text-right px-4 py-2 font-semibold">Accion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map(s => (
                      <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2 font-mono text-xs">{s.email}</td>
                        <td className="px-4 py-2">{s.name}</td>
                        <td className="px-4 py-2 text-slate-600">{s.tenantName}</td>
                        <td className="px-4 py-2 text-xs">
                          <span className={`px-2 py-0.5 rounded ${s.role === 'owner' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                            {s.role}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs">{s.active ? 'si' : 'no'}</td>
                        <td className="px-4 py-2 text-xs text-slate-500">
                          {s.tokensInvalidatedAt ? new Date(s.tokensInvalidatedAt).toLocaleString() : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => forceLogout({ id: s.id, label: `${s.email} (${s.tenantName})` }, true)}
                            disabled={busyId === s.id}
                            className="aa-btn inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold disabled:opacity-50 hover:bg-red-700"
                          >
                            <MdLogout className="w-3.5 h-3.5" />
                            <span className="relative z-10">{busyId === s.id ? '...' : 'Cerrar sesion'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
