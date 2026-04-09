'use client'

/**
 * Consumer layout — mobile-first PWA that stays phone-width on desktop.
 * On a wide screen (laptop, tablet landscape) the content centers in a
 * phone-shaped column with a subtle shadow. Avoids the "stretched" look.
 */
export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 lg:py-6">
      <div className="lg:max-w-md lg:mx-auto lg:shadow-xl lg:rounded-2xl lg:overflow-hidden lg:bg-white min-h-screen lg:min-h-[calc(100vh-3rem)]">
        {children}
      </div>
    </div>
  )
}
