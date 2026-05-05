import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
  display: 'swap',
  weight: '100 900',
})

const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  display: 'swap',
  weight: '100 900',
})

export const metadata: Metadata = {
  title: 'Valee — Gana recompensas en tus comercios favoritos',
  description: 'Cada compra cuenta. Acumula puntos en cada visita y canjealos por productos.',
  // Meta Business Manager domain ownership verification for valee.app. This
  // tag must be in the static server-rendered <head> of the homepage (must
  // NOT be added via JS after load) or Meta rejects the verification.
  other: {
    'facebook-domain-verification': '0nh418uqc36808waxn3b5s4tmonpiv',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#6366f1',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-gray-50 antialiased font-sans">
        {children}
      </body>
    </html>
  )
}
