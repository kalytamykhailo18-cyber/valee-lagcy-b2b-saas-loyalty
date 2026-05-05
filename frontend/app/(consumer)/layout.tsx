'use client'

/**
 * Consumer layout — mobile-first PWA that stays phone-width on desktop.
 * On a wide screen (laptop, tablet landscape) the content centers in a
 * phone-shaped column with a subtle shadow. Avoids the "stretched" look.
 */
export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      {children}
    </div>
  )
}
