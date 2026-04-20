'use client'

import { useState, useEffect, useCallback, type ReactNode, type ComponentType } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  MdDashboard, MdQrCodeScanner, MdAccessTime, MdInventory2,
  MdLocalOffer, MdUploadFile, MdPeople, MdStorefront, MdAutorenew,
  MdFeedback, MdSettings, MdMenu, MdLogout, MdGroups, MdArrowBack, MdBadge,
} from 'react-icons/md'

interface NavItem {
  href: string
  label: string
  Icon: ComponentType<{ className?: string }>
  ownerOnly?: boolean
  preview?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { href: '/merchant', label: 'Panel', Icon: MdDashboard },
  { href: '/merchant/scanner', label: 'Escaner de canje', Icon: MdQrCodeScanner },
  { href: '/merchant/dual-scan', label: 'Pago en efectivo', Icon: MdAccessTime },
  { href: '/merchant/products', label: 'Productos', Icon: MdInventory2, ownerOnly: true },
  { href: '/merchant/hybrid-deals', label: 'Promociones hibridas', Icon: MdLocalOffer, ownerOnly: true },
  { href: '/merchant/csv-upload', label: 'Cargar CSV', Icon: MdUploadFile, ownerOnly: true },
  { href: '/merchant/customers', label: 'Clientes', Icon: MdPeople },
  { href: '/merchant/segments', label: 'Segmentos', Icon: MdGroups, ownerOnly: true, preview: true },
  { href: '/merchant/branches', label: 'Sucursales', Icon: MdStorefront, ownerOnly: true },
  { href: '/merchant/staff', label: 'Cajeros y QR', Icon: MdBadge, ownerOnly: true },
  { href: '/merchant/recurrence', label: 'Recurrencia', Icon: MdAutorenew, ownerOnly: true },
  { href: '/merchant/disputes', label: 'Disputas', Icon: MdFeedback, ownerOnly: true },
  { href: '/merchant/settings', label: 'Configuracion', Icon: MdSettings, ownerOnly: true },
]

export default function MerchantLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<string | null>(null)
  const [staffName, setStaffName] = useState<string>('')
  const [tenantName, setTenantName] = useState<string>('')
  const [tenantLogoUrl, setTenantLogoUrl] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // `authChecked` gates protected page rendering until we've confirmed we
  // actually have a session. Without this, the internals flash visible to an
  // unauthenticated user for the tick between mount and the redirect firing.
  const [authChecked, setAuthChecked] = useState(false)
  const [authorized, setAuthorized] = useState(false)

  const PUBLIC_ROUTES = ['/merchant/login', '/merchant/signup', '/merchant/scanner', '/merchant/forgot-password', '/merchant/reset-password']

  useEffect(() => {
    setMounted(true)
  }, [])

  // Re-read localStorage on every navigation. This is required because the layout
  // does NOT remount when going from /merchant/login → /merchant, so a single
  // mount-time read would miss the role/name written by the login page.
  const runAuthCheck = useCallback(() => {
    const storedRole = localStorage.getItem('staffRole')
    const storedToken = localStorage.getItem('staffAccessToken') || localStorage.getItem('accessToken')
    setRole(storedRole)
    setStaffName(localStorage.getItem('staffName') || '')
    setTenantName(localStorage.getItem('tenantName') || '')
    setTenantLogoUrl(localStorage.getItem('tenantLogoUrl') || null)
    setDrawerOpen(false)

    // Auth guard: if visiting a protected merchant route without a session,
    // redirect to login. Public routes (login/signup/scanner) are allowed.
    const isPublic = PUBLIC_ROUTES.includes(pathname)
    const hasSession = !!storedToken && !!storedRole
    if (!isPublic && !hasSession) {
      setAuthorized(false)
      setAuthChecked(true)
      // Hard nav rather than router.replace so the back/forward cache doesn't
      // resurrect the protected page we just bounced out of.
      window.location.replace('/merchant/login')
    } else {
      setAuthorized(true)
      setAuthChecked(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  useEffect(() => { runAuthCheck() }, [runAuthCheck])

  // Re-run the check when the tab becomes visible again (user switched away and
  // came back) or when the page is restored from the bfcache via swipe-back.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') runAuthCheck() }
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) runAuthCheck() }
    const onStorage = (e: StorageEvent) => { if (e.key === 'staffAccessToken' || e.key === 'accessToken' || e.key === 'staffRole') runAuthCheck() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('storage', onStorage)
    }
  }, [runAuthCheck])

  // Fetch tenant info if not in localStorage (first visit after login)
  useEffect(() => {
    if (!mounted || !role) return
    if (tenantName && tenantLogoUrl !== null) return // already loaded or explicitly null
    ;(async () => {
      try {
        const { api } = await import('@/lib/api')
        const s = await api.getMerchantSettings()
        if (s?.name) {
          setTenantName(s.name)
          localStorage.setItem('tenantName', s.name)
        }
        if (s?.logoUrl !== undefined) {
          setTenantLogoUrl(s.logoUrl)
          if (s.logoUrl) localStorage.setItem('tenantLogoUrl', s.logoUrl)
          else localStorage.removeItem('tenantLogoUrl')
        }
      } catch {}
    })()
  }, [mounted, role, tenantName, tenantLogoUrl])

  const bareRoutes = ['/merchant/login', '/merchant/signup', '/merchant/scanner', '/merchant/forgot-password', '/merchant/reset-password']
  if (bareRoutes.includes(pathname)) {
    return <>{children}</>
  }

  async function logout() {
    // Server-side logout bumps staff.tokens_invalidated_at so the JWT can't
    // be refreshed or reused even if it was copied before the client-side
    // clear. Done before localStorage wipe so the Authorization header is
    // still attached to the request.
    try {
      const { getAccess } = await import('@/lib/token-store')
      const token = getAccess('staff')
      if (token) {
        await fetch('/api/merchant/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        })
      }
    } catch {}
    const { clearTokens } = await import('@/lib/token-store')
    clearTokens('staff')
    localStorage.removeItem('staffRole')
    localStorage.removeItem('staffName')
    localStorage.removeItem('tenantName')
    localStorage.removeItem('tenantLogoUrl')
    // Hard navigation — router.push keeps the previous page in the back/forward
    // cache, letting a logged-out user swipe back into the merchant internals.
    window.location.href = '/merchant/login'
  }

  const visibleNav = NAV_ITEMS.filter(item => {
    if (item.ownerOnly && role !== 'owner') return false
    return true
  })

  const sidebarContent = (
    <>
      <div className="h-16 flex items-center gap-3 px-4 border-b border-slate-200 flex-shrink-0">
        <Link href="/merchant" className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition">
          {tenantLogoUrl ? (
            <img src={tenantLogoUrl} alt={tenantName || 'Logo'} className="w-10 h-10 rounded-lg object-cover border border-slate-200 flex-shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-extrabold text-lg flex-shrink-0">
              {(tenantName || 'V').charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-base font-extrabold tracking-tight text-emerald-700 truncate">{tenantName || 'Valee'}</p>
            {role && (
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">{role}</p>
            )}
          </div>
        </Link>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {visibleNav.map(item => {
          const active = pathname === item.href || (item.href !== '/merchant' && pathname.startsWith(item.href))
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                transition-all
                ${active
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'
                }
              `}
            >
              <item.Icon className="w-5 h-5 flex-shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {item.preview && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${active ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-700'}`}>
                  PREVIEW
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="p-3 border-t border-slate-200 flex-shrink-0">
        {staffName && (
          <p className="text-xs text-slate-500 px-3 mb-2 truncate">{staffName}</p>
        )}
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 transition-all"
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
        <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-40">
          {sidebarContent}
        </aside>
      )}

      {mounted && authorized && (
        <>
          <div
            onClick={() => setDrawerOpen(false)}
            className={`lg:hidden fixed inset-0 bg-slate-900/50 z-40 transition-opacity duration-200 ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
          />
          <aside className={`lg:hidden fixed inset-y-0 left-0 w-64 bg-white border-r border-slate-200 z-50 flex flex-col transform transition-transform duration-200 ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {sidebarContent}
          </aside>
        </>
      )}

      {mounted && authorized && !drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden fixed bottom-6 left-6 z-30 w-14 h-14 rounded-full bg-emerald-600 text-white shadow-xl flex items-center justify-center hover:bg-emerald-700 active:scale-95 transition"
          aria-label="Abrir menu"
        >
          <MdMenu className="w-7 h-7" />
        </button>
      )}

      <main className="lg:pl-64 min-h-screen">
        {/* Mobile top bar with back arrow — only on sub-pages, not dashboard */}
        {mounted && authorized && pathname !== '/merchant' && !PUBLIC_ROUTES.includes(pathname) && (
          <div className="lg:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-20">
            <button
              onClick={() => {
                // Use browser back so the dashboard restores the scroll position
                // the user was at before entering this sub-page. Falls back to
                // /merchant if there's no history (direct URL entry).
                if (window.history.length > 1) router.back()
                else window.location.href = '/merchant'
              }}
              className="text-emerald-700 hover:-translate-x-0.5 transition-transform"
            >
              <MdArrowBack className="w-6 h-6" />
            </button>
            <span className="text-sm font-semibold text-slate-700 truncate">
              {visibleNav.find(n => pathname.startsWith(n.href) && n.href !== '/merchant')?.label || 'Valee'}
            </span>
          </div>
        )}
        {(!authChecked || !authorized) ? (
          <div className="min-h-screen flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  )
}
