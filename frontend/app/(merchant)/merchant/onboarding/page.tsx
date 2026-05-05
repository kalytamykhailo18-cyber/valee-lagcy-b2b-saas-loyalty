'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { MdQrCode2, MdStars, MdInventory2, MdCheckCircle, MdArrowForward, MdArrowBack, MdDownload, MdContentCopy, MdStorefront } from 'react-icons/md'
import { api } from '@/lib/api'

interface Settings {
  name: string
  slug: string
  qrCodeUrl: string | null
  welcomeBonusAmount: number
  referralBonusAmount: number
  referenceCurrency: string
  productCount: number
  unitLabel: string
  assetTypeId: string | null
}

type Step = 1 | 2 | 3 | 4 | 5
type BranchModel = '' | 'single' | 'multi'

// Display integer with dot thousand separator (LATAM convention).
// Eric 2026-04-25: bonus inputs need '5.000' / '1.000' formatting.
const fmtThousands = (s: string) => {
  const digits = String(s).replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
const stripNonDigits = (s: string) => s.replace(/\D/g, '')

export default function OnboardingWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Step 2 form state — seeded from server values so re-entering the wizard
  // picks up where the merchant left off instead of silently overwriting.
  // Defaults bumped to 5000 / 1000 (Eric 2026-04-25). Stored as raw digits;
  // displayed with dot thousand separators in the inputs.
  const [welcomeBonus, setWelcomeBonus] = useState<string>('5000')
  const [referralBonus, setReferralBonus] = useState<string>('1000')
  const [currency, setCurrency] = useState<string>('usd')

  // Step 3 (Sucursales) state — Genesis 2026-04-24: owners need to
  // declare early if they work with multiple branches, so the product
  // step can ask which one. 'single' keeps the old flow untouched.
  const [branchModel, setBranchModel] = useState<BranchModel>('')
  const [firstBranchName, setFirstBranchName] = useState('')
  const [firstBranchAddress, setFirstBranchAddress] = useState('')
  const [createdBranchId, setCreatedBranchId] = useState<string | null>(null)

  // Step 4 (Producto) form state
  const [productName, setProductName] = useState('')
  const [productCost, setProductCost] = useState('3000')
  const [productStock, setProductStock] = useState('10')
  const [productBranchId, setProductBranchId] = useState('')
  const [productPhotoUrl, setProductPhotoUrl] = useState<string | null>(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('staffAccessToken') || localStorage.getItem('accessToken')
    const role = localStorage.getItem('staffRole')
    if (!token || role !== 'owner') {
      window.location.replace('/merchant/login')
      return
    }
    ;(async () => {
      try {
        const s = await api.getMerchantSettings()
        setSettings(s)
        setWelcomeBonus(String(s.welcomeBonusAmount ?? 5000))
        setReferralBonus(String(s.referralBonusAmount ?? 1000))
        setCurrency(s.referenceCurrency || 'usd')
      } catch (e: any) {
        setError(e?.error || 'No se pudo cargar la configuracion')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function saveStep2AndNext() {
    setError('')
    setSaving(true)
    try {
      await api.updateMerchantSettings({
        welcomeBonusAmount: Math.max(0, parseInt(welcomeBonus) || 0),
        referralBonusAmount: Math.max(0, parseInt(referralBonus) || 0),
        referenceCurrency: currency,
      })
      setStep(3)
    } catch (e: any) {
      setError(e?.error || 'No se pudo guardar')
    } finally {
      setSaving(false)
    }
  }

  async function saveStep3AndNext() {
    setError('')
    if (!branchModel) {
      setError('Elegi si tu comercio tiene una sola sede o trabaja con sucursales.')
      return
    }
    setSaving(true)
    try {
      // If the owner picks "multi" and has not created a branch yet,
      // create it now so step 4 (Producto) can pre-select it in the
      // branch dropdown. Idempotent: if the user clicks Siguiente
      // twice we don't create duplicate branches.
      if (branchModel === 'multi' && !createdBranchId) {
        if (!firstBranchName.trim()) {
          setError('Ponle un nombre a tu primera sucursal (ej: Centro, Sede 1).')
          setSaving(false)
          return
        }
        const res: any = await api.createBranch({
          name: firstBranchName.trim(),
          address: firstBranchAddress.trim() || undefined,
        })
        const bid = res?.branch?.id || res?.id
        if (bid) {
          setCreatedBranchId(bid)
          setProductBranchId(bid)
        }
      }
      setStep(4)
    } catch (e: any) {
      setError(e?.error || 'No se pudo crear la sucursal')
    } finally {
      setSaving(false)
    }
  }

  async function handleProductPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('La foto debe ser menor a 2MB')
      return
    }
    setUploadingPhoto(true)
    setError('')
    try {
      const result = await api.uploadProductImage(file)
      setProductPhotoUrl(result.url)
    } catch (err: any) {
      setError(err?.error || err?.message || 'Error al subir la foto')
    }
    setUploadingPhoto(false)
  }

  async function saveStep4AndFinish() {
    setError('')
    setSaving(true)
    try {
      if (productName.trim() && productCost.trim()) {
        const cost = Math.max(1, parseInt(productCost) || 0)
        const stock = Math.max(0, parseInt(productStock) || 0)
        // assetTypeId is required by the product endpoint; the wizard seeds
        // it from the tenant's asset config which was created during signup.
        if (!settings?.assetTypeId) {
          throw { error: 'El tipo de puntos aun no esta listo. Intenta de nuevo en un momento.' }
        }
        await api.createProduct({
          name: productName.trim(),
          redemptionCost: String(cost),
          assetTypeId: settings.assetTypeId,
          stock,
          active: true,
          photoUrl: productPhotoUrl || undefined,
          // Attach the branch only when the merchant declared multi-branch
          // on step 3. Single-sede merchants never see a branch selector
          // and keep the tenant-wide product behavior they had before.
          branchId: branchModel === 'multi' ? (productBranchId || createdBranchId || undefined) : undefined,
        })
      }
      setStep(5)
    } catch (e: any) {
      setError(e?.error || 'No se pudo crear el producto')
    } finally {
      setSaving(false)
    }
  }

  async function downloadQR() {
    if (!settings?.qrCodeUrl) return
    // Proper file download: fetch the Cloudinary PNG as a blob and trigger
    // an anchor click with `download` so the browser saves it to disk with
    // the merchant's slug as the filename, instead of just opening the
    // image inline in a new tab (which was what the button did before).
    try {
      const res = await fetch(settings.qrCodeUrl)
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `valee-qr-${settings.slug || 'comercio'}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on the next tick so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 500)
    } catch {
      // If CORS blocks the blob fetch (Cloudinary usually allows it, but
      // being defensive), fall back to opening the URL so the user can
      // right-click → Save As.
      window.open(settings.qrCodeUrl, '_blank', 'noopener')
    }
  }

  async function copyQRLink() {
    if (!settings?.qrCodeUrl) return
    try {
      await navigator.clipboard.writeText(settings.qrCodeUrl)
      alert('Enlace copiado. Pegalo donde quieras compartirlo.')
    } catch {
      window.prompt('Copia este enlace:', settings.qrCodeUrl)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-50">
        <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-50 p-6">
        <div className="text-center max-w-md">
          <p className="text-red-600 mb-4">{error || 'Error al cargar'}</p>
          <Link href="/merchant" className="text-emerald-700 underline">Ir al panel</Link>
        </div>
      </div>
    )
  }

  const steps: Array<{ n: Step; label: string; Icon: typeof MdQrCode2 }> = [
    { n: 1, label: 'Tu QR',      Icon: MdQrCode2 },
    { n: 2, label: 'Puntos',     Icon: MdStars },
    { n: 3, label: 'Sucursales', Icon: MdStorefront },
    { n: 4, label: 'Producto',   Icon: MdInventory2 },
    { n: 5, label: 'Listo',      Icon: MdCheckCircle },
  ]

  return (
    <div className="min-h-screen bg-emerald-50 pb-16">
      <header className="pt-8 pb-4 text-center aa-rise-sm">
        <h1 className="text-2xl font-bold text-emerald-800 tracking-tight">Bienvenido, {settings.name}</h1>
        <p className="text-sm text-slate-500 mt-1">Vamos a configurar tu comercio en 4 pasos</p>
      </header>

      {/* Step indicator */}
      <div className="max-w-3xl mx-auto px-4 mb-6">
        <div className="flex items-center justify-between">
          {steps.map((s, i) => {
            const done = step > s.n
            const active = step === s.n
            return (
              <div key={s.n} className="flex items-center flex-1">
                <div className={`flex flex-col items-center ${i === 0 ? '' : 'flex-1'}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center transition ${
                    done ? 'bg-emerald-600 text-white' :
                    active ? 'bg-emerald-500 text-white ring-4 ring-emerald-200' :
                    'bg-slate-200 text-slate-500'
                  }`}>
                    <s.Icon className="w-5 h-5" />
                  </div>
                  <span className={`text-[10px] mt-1 font-semibold uppercase tracking-wide ${active ? 'text-emerald-700' : 'text-slate-400'}`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`h-0.5 flex-1 mx-2 ${step > s.n ? 'bg-emerald-500' : 'bg-slate-200'}`} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <main className="max-w-xl mx-auto px-4">
        {error && (
          <div className="aa-pop bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === 1 && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4 aa-rise">
            <h2 className="text-lg font-bold text-slate-800">Tu codigo QR</h2>
            <p className="text-sm text-slate-500">
              Este es el codigo que tus clientes van a escanear para empezar a acumular puntos.
              Puedes imprimirlo y ponerlo en tu caja o mostrador.
            </p>
            {settings.qrCodeUrl ? (
              <div className="flex flex-col items-center gap-3">
                <img src={settings.qrCodeUrl} alt="QR del comercio" className="w-56 h-56 rounded-xl border border-slate-200" />
                <div className="flex gap-2 flex-wrap justify-center">
                  <button
                    onClick={downloadQR}
                    className="aa-btn aa-btn-emerald flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700"
                  >
                    <MdDownload className="w-4 h-4" /><span className="relative z-10">Descargar PNG</span>
                  </button>
                  <button
                    onClick={copyQRLink}
                    className="aa-btn flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium hover:bg-slate-50"
                  >
                    <MdContentCopy className="w-4 h-4" /><span className="relative z-10">Copiar enlace</span>
                  </button>
                </div>
                <p className="text-xs text-slate-400 text-center">
                  En el telefono, tocas Descargar PNG y queda en tu galeria.
                  En la computadora, se guarda en tu carpeta de descargas listo para imprimir.
                </p>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                Tu QR todavia se esta generando. Podes continuar con los siguientes pasos; estara disponible en Configuracion cuando termine.
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setStep(2)}
                className="aa-btn aa-btn-emerald flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-semibold hover:bg-emerald-700"
              >
                <span className="relative z-10">Siguiente</span><MdArrowForward className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4 aa-rise">
            <h2 className="text-lg font-bold text-slate-800">Configuracion de puntos</h2>
            <p className="text-sm text-slate-500">
              Cuantos puntos gana un cliente nuevo y cuanto vale invitar a un amigo.
              Siempre podes cambiarlo despues desde Configuracion.
            </p>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Bono de bienvenida</label>
              <input
                type="text" inputMode="numeric"
                value={fmtThousands(welcomeBonus)}
                onChange={e => setWelcomeBonus(stripNonDigits(e.target.value))}
                className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
              />
              <p className="text-xs text-slate-400 mt-1">Puntos que recibe un cliente nuevo al escanear tu QR por primera vez</p>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Bono por referido</label>
              <input
                type="text" inputMode="numeric"
                value={fmtThousands(referralBonus)}
                onChange={e => setReferralBonus(stripNonDigits(e.target.value))}
                className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
              />
              <p className="text-xs text-slate-400 mt-1">Puntos que recibe un cliente cuando invita a otro que compra por primera vez</p>
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Moneda de referencia</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="aa-field w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm bg-white"
              >
                <option value="usd">Dolar (USD)</option>
                <option value="eur">Euro (EUR)</option>
                <option value="bs">Bolivar (BS)</option>
              </select>
              <p className="text-xs text-slate-400 mt-1">Las facturas en Bs se convertiran a esta moneda para calcular puntos</p>
            </div>
            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(1)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
                <MdArrowBack className="w-4 h-4" />Atras
              </button>
              <button
                onClick={saveStep2AndNext}
                disabled={saving}
                className="aa-btn aa-btn-emerald flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-semibold disabled:opacity-50 hover:bg-emerald-700"
              >
                {saving && <span className="aa-spinner" />}<span className="relative z-10">Siguiente</span><MdArrowForward className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4 aa-rise">
            <h2 className="text-lg font-bold text-slate-800">Como trabaja tu comercio?</h2>
            <p className="text-sm text-slate-500">
              Contanos si vas a manejar una sola sede o varias sucursales.
              Esto cambia como se asignan tus productos y cajeros.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setBranchModel('single')}
                className={`text-left p-4 rounded-xl border-2 transition ${branchModel === 'single' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}
              >
                <p className="font-semibold text-slate-800">Comercio unico</p>
                <p className="text-xs text-slate-500 mt-1">Tengo un solo local. Los productos y cajeros aplican en todo el comercio.</p>
              </button>
              <button
                type="button"
                onClick={() => setBranchModel('multi')}
                className={`text-left p-4 rounded-xl border-2 transition ${branchModel === 'multi' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}
              >
                <p className="font-semibold text-slate-800">Tengo sucursales</p>
                <p className="text-xs text-slate-500 mt-1">Trabajo con varias sedes. Voy a asignar productos y cajeros a cada una.</p>
              </button>
            </div>

            {branchModel === 'multi' && !createdBranchId && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-emerald-800">Crea tu primera sucursal</p>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre de la sucursal</label>
                  <input
                    type="text"
                    placeholder="Ej: Centro, Sede Norte"
                    value={firstBranchName}
                    onChange={e => setFirstBranchName(e.target.value)}
                    className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Direccion (opcional)</label>
                  <input
                    type="text"
                    placeholder="Av. Bolivar, Valencia"
                    value={firstBranchAddress}
                    onChange={e => setFirstBranchAddress(e.target.value)}
                    className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                  />
                </div>
                <p className="text-xs text-slate-500">Podes crear mas sucursales despues desde la seccion Sucursales.</p>
              </div>
            )}

            {branchModel === 'multi' && createdBranchId && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-800">
                Sucursal &ldquo;{firstBranchName}&rdquo; lista. En el siguiente paso se asociara tu primer producto a esta sucursal.
              </div>
            )}

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(2)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
                <MdArrowBack className="w-4 h-4" />Atras
              </button>
              <button
                onClick={saveStep3AndNext}
                disabled={saving || !branchModel}
                className="aa-btn aa-btn-emerald flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-semibold disabled:opacity-50 hover:bg-emerald-700"
              >
                {saving && <span className="aa-spinner" />}<span className="relative z-10">Siguiente</span><MdArrowForward className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4 aa-rise">
            <h2 className="text-lg font-bold text-slate-800">Tu primer premio</h2>
            <p className="text-sm text-slate-500">
              Agrega un premio que los clientes puedan canjear. Podes saltar este paso y agregarlo despues.
            </p>
            {settings.productCount > 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-800">
                Ya tenes {settings.productCount} premio{settings.productCount === 1 ? '' : 's'} configurado{settings.productCount === 1 ? '' : 's'}. Podes agregar mas ahora o saltar.
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Nombre</label>
              <input
                type="text"
                value={productName}
                onChange={e => setProductName(e.target.value)}
                placeholder="Ej: Cafe gratis"
                className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Foto del premio</label>
              <div className="mt-1 flex items-center gap-3">
                {productPhotoUrl ? (
                  <img src={productPhotoUrl} alt="" className="w-16 h-16 rounded-lg object-cover border border-slate-200" />
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center text-xs text-slate-400">
                    Sin foto
                  </div>
                )}
                <div className="flex-1 space-y-1">
                  <label className="inline-block cursor-pointer bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-emerald-700 transition disabled:opacity-50">
                    {uploadingPhoto ? 'Subiendo...' : productPhotoUrl ? 'Cambiar foto' : 'Subir foto'}
                    <input type="file" accept="image/*" onChange={handleProductPhotoUpload} disabled={uploadingPhoto} className="hidden" />
                  </label>
                  {productPhotoUrl && (
                    <button
                      type="button"
                      onClick={() => setProductPhotoUrl(null)}
                      className="block text-xs text-red-600 hover:text-red-800 font-medium"
                    >
                      Quitar foto
                    </button>
                  )}
                  <p className="text-xs text-slate-400">Recomendado: cuadrada, max 2MB. La foto tambien se va a usar en nuestro marketplace, donde miles de personas veran los mejores incentivos que ofreces a tus clientes premium.</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Costo (puntos)</label>
                <input
                  type="text" inputMode="numeric"
                  value={fmtThousands(productCost)}
                  onChange={e => setProductCost(stripNonDigits(e.target.value))}
                  placeholder="3.000"
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Stock</label>
                <input
                  type="text" inputMode="numeric"
                  value={fmtThousands(productStock)}
                  onChange={e => setProductStock(stripNonDigits(e.target.value))}
                  className="aa-field aa-field-emerald w-full mt-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
                />
              </div>
            </div>
            {branchModel === 'multi' && createdBranchId && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-800">
                Este primer premio se va a asociar a <span className="font-semibold">{firstBranchName}</span>. Podes cambiarlo o sumar mas sucursales en el catalogo mas tarde.
              </div>
            )}
            <div className="flex justify-between pt-2">
              <button onClick={() => setStep(3)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
                <MdArrowBack className="w-4 h-4" />Atras
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => setStep(5)} className="text-sm text-slate-500 hover:text-slate-700">
                  Saltar
                </button>
                <button
                  onClick={saveStep4AndFinish}
                  disabled={saving}
                  className="aa-btn aa-btn-emerald flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-xl font-semibold disabled:opacity-50 hover:bg-emerald-700"
                >
                  {saving && <span className="aa-spinner" />}<span className="relative z-10">{productName.trim() ? 'Crear y seguir' : 'Siguiente'}</span><MdArrowForward className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 text-center space-y-4 aa-pop">
            <div className="w-16 h-16 mx-auto bg-emerald-100 rounded-full flex items-center justify-center">
              <MdCheckCircle className="w-10 h-10 text-emerald-600" />
            </div>
            <h2 className="text-xl font-bold text-slate-800">¡Tu comercio ya esta listo para fidelizar!</h2>
            <p className="text-sm text-slate-500">
              Sigue estos 3 pasos para convertir visitas en ventas recurrentes:
            </p>
            <div className="bg-slate-50 rounded-xl p-4 text-left text-sm text-slate-600 space-y-3">
              <div className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">1</span>
                <div>
                  <p className="font-semibold text-slate-800">Imprime tu QR</p>
                  <p className="mt-0.5">Tus clientes ahora tienen una razon mas para volver. Descarga tu QR, ponlo en un lugar visible y deja que la magia ocurra. Cada escaneo es un cliente que regresa.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">2</span>
                <div>
                  <p className="font-semibold text-slate-800">Empodera a tu equipo</p>
                  <p className="mt-0.5">Ve a Cajeros y QR. Crea un codigo personalizado para cada mesonero o cajero. Asi podras medir quien esta impulsando mas la lealtad en tu local y garantizar que nadie se quede sin sus puntos.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">3</span>
                <div>
                  <p className="font-semibold text-slate-800">Validacion anti-fraude</p>
                  <p className="mt-0.5">Ve a Cargar CSV donde podras cargar las facturas de tus ventas diarias. Es el paso final para convertir puntos provisionales en recompensas reales.</p>
                </div>
              </div>
            </div>
            <button
              onClick={() => router.push('/merchant')}
              className="aa-btn aa-btn-emerald w-full bg-emerald-600 text-white py-3 rounded-xl font-semibold hover:bg-emerald-700"
            >
              <span className="relative z-10">¡Empezemos a fidelizar ahora!</span>
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
