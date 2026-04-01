import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-8">
        <h1 className="text-4xl font-bold text-indigo-600">Loyalty Platform</h1>
        <p className="text-slate-500">Select your portal</p>
        <div className="flex flex-col gap-4 w-64 mx-auto">
          <Link href="/consumer" className="block bg-indigo-600 text-white rounded-xl py-3 px-6 font-medium hover:bg-indigo-700 transition">
            Consumer App
          </Link>
          <Link href="/merchant/login" className="block bg-emerald-600 text-white rounded-xl py-3 px-6 font-medium hover:bg-emerald-700 transition">
            Merchant Dashboard
          </Link>
          <Link href="/admin/login" className="block bg-slate-800 text-white rounded-xl py-3 px-6 font-medium hover:bg-slate-900 transition">
            Admin Panel
          </Link>
        </div>
      </div>
    </div>
  )
}
