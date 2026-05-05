'use client'

import { useState, useEffect, useCallback, type ReactNode, type ComponentType } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  MdDashboard, MdStorefront, MdMenuBook, MdTune,
  MdMenu, MdLogout,
} from 'react-icons/md'

interface NavItem {
  href: string
  label: string
  Icon: ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Panel', Icon: MdDashboard },
  { href: '/admin/tenants', label: 'Comercios', Icon: MdStorefront },
  { href: '/admin/ledger', label: 'Ledger global', Icon: MdMenuBook },
  { href: '/admin/adjustments', label: 'Ajustes manuales', Icon: MdTune },
]

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [authorized, setAuthorized] = useState(false)

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => { setDrawerOpen(false) }, [pathname])

  // Auth guard: block rendering admin internals until we confirm a session.
  const runAuthCheck = useCallback(() => {
    if (pathname === '/admin/login') {
      setAuthorized(true)
      setAuthChecked(true)
      return
    }
    const token = localStorage.getItem('adminAccessToken') || localStorage.getItem('adminToken') || localStorage.getItem('accessToken')
    if (!token) {
      setAuthorized(false)
      setAuthChecked(true)
      // Hard nav so bfcache doesn't restore the previous protected page.
      window.location.replace('/admin/login')
    } else {
      setAuthorized(true)
      setAuthChecked(true)
    }
  }, [pathname])

  useEffect(() => { runAuthCheck() }, [runAuthCheck])

  // Re-run on tab focus, bfcache restore, and cross-tab storage changes.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') runAuthCheck() }
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) runAuthCheck() }
    const onStorage = (e: StorageEvent) => { if (e.key === 'adminAccessToken' || e.key === 'adminToken' || e.key === 'accessToken') runAuthCheck() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('storage', onStorage)
    }
  }, [runAuthCheck])

  if (pathname === '/admin/login') {
    return <>{children}</>
  }

  async function logout() {
    const { clearTokens } = await import('@/lib/token-store')
    clearTokens('admin')
    localStorage.removeItem('adminToken')
    localStorage.removeItem('adminName')
    // Hard nav so bfcache doesn't restore the previous page if the user swipes back.
    window.location.href = '/admin/login'
  }

  const sidebarContent = (
    <>
      <div className="h-16 flex items-center px-6 border-b border-slate-700 flex-shrink-0">
        <Link
          href="/admin"
          className="text-2xl font-extrabold tracking-tight text-white hover:text-indigo-200 transition-colors"
        >
          Valee
        </Link>
        <span className="ml-3 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Admin</span>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(item => {
          const active = pathname === item.href || (item.href !== '/admin' && pathname.startsWith(item.href))
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}`}
            >
              <item.Icon className="w-5 h-5 flex-shrink-0" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="p-3 border-t border-slate-700 flex-shrink-0">
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-red-900/40 hover:text-red-300 transition-all"
        >
          <MdLogout className="w-5 h-5" />
          Cerrar sesion
        </button>
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-slate-50">
      {mounted && authorized && (
        <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-slate-800 border-r border-slate-700 z-40">
          {sidebarContent}
        </aside>
      )}

      {mounted && authorized && (
        <>
          <div
            onClick={() => setDrawerOpen(false)}
            className={`lg:hidden fixed inset-0 bg-black/60 z-40 transition-opacity duration-200 ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
          />
          <aside className={`lg:hidden fixed inset-y-0 left-0 w-64 bg-slate-800 border-r border-slate-700 z-50 flex flex-col transform transition-transform duration-200 ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {sidebarContent}
          </aside>
        </>
      )}

      {mounted && authorized && !drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden fixed bottom-6 left-6 z-30 w-14 h-14 rounded-full bg-indigo-600 text-white shadow-xl flex items-center justify-center hover:bg-indigo-700 active:scale-95 transition"
          aria-label="Abrir menu"
        >
          <MdMenu className="w-7 h-7" />
        </button>
      )}

      <main className="lg:pl-64 min-h-screen">
        {(!authChecked || !authorized) ? (
          <div className="min-h-screen flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  )
}
