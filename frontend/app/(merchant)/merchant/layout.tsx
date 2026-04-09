'use client'

import { useState, useEffect, type ReactNode, type ComponentType } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  MdDashboard, MdQrCodeScanner, MdAccessTime, MdInventory2,
  MdUploadFile, MdPeople, MdStorefront, MdAutorenew,
  MdFeedback, MdSettings, MdMenu, MdLogout,
} from 'react-icons/md'

interface NavItem {
  href: string
  label: string
  Icon: ComponentType<{ className?: string }>
  ownerOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { href: '/merchant', label: 'Panel', Icon: MdDashboard },
  { href: '/merchant/scanner', label: 'Escaner de canje', Icon: MdQrCodeScanner },
  { href: '/merchant/dual-scan', label: 'Sin factura', Icon: MdAccessTime },
  { href: '/merchant/products', label: 'Productos', Icon: MdInventory2, ownerOnly: true },
  { href: '/merchant/csv-upload', label: 'Cargar CSV', Icon: MdUploadFile, ownerOnly: true },
  { href: '/merchant/customers', label: 'Clientes', Icon: MdPeople },
  { href: '/merchant/branches', label: 'Sucursales', Icon: MdStorefront, ownerOnly: true },
  { href: '/merchant/recurrence', label: 'Recurrencia', Icon: MdAutorenew, ownerOnly: true },
  { href: '/merchant/disputes', label: 'Disputas', Icon: MdFeedback, ownerOnly: true },
  { href: '/merchant/settings', label: 'Configuracion', Icon: MdSettings, ownerOnly: true },
]

export default function MerchantLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<string | null>(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('staffRole')
    return null
  })
  const [staffName, setStaffName] = useState<string>(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('staffName') || ''
    return ''
  })
  const [mounted, setMounted] = useState(() => typeof window !== 'undefined')
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => { setDrawerOpen(false) }, [pathname])

  const bareRoutes = ['/merchant/login', '/merchant/scanner']
  if (bareRoutes.includes(pathname)) {
    return <>{children}</>
  }

  function logout() {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('staffRole')
    localStorage.removeItem('staffName')
    router.push('/merchant/login')
  }

  const visibleNav = NAV_ITEMS.filter(item => {
    if (item.ownerOnly && role !== 'owner') return false
    return true
  })

  const sidebarContent = (
    <>
      <div className="h-16 flex items-center px-6 border-b border-slate-200 flex-shrink-0">
        <h1 className="text-2xl font-bold text-emerald-700">Valee</h1>
        {role && (
          <span className="ml-3 text-xs text-slate-400 uppercase tracking-wide">{role}</span>
        )}
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
              <span>{item.label}</span>
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
      {mounted && (
        <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-40">
          {sidebarContent}
        </aside>
      )}

      {mounted && (
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

      {mounted && !drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden fixed bottom-6 left-6 z-30 w-14 h-14 rounded-full bg-emerald-600 text-white shadow-xl flex items-center justify-center hover:bg-emerald-700 active:scale-95 transition"
          aria-label="Abrir menu"
        >
          <MdMenu className="w-7 h-7" />
        </button>
      )}

      <main className="lg:pl-64 min-h-screen">
        {children}
      </main>
    </div>
  )
}
