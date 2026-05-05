import Link from 'next/link'

export const metadata = {
  title: 'Terminos y condiciones - Valee',
  description: 'Terminos y condiciones de uso de Valee, plataforma de fidelizacion para comercios.',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen flex flex-col bg-emerald-50">
      <header className="py-6 text-center aa-rise-sm">
        <Link
          href="/"
          className="inline-block text-3xl font-extrabold tracking-tight text-emerald-700 hover:text-emerald-800 transition-colors"
        >
          Valee
        </Link>
      </header>

      <main className="flex-1">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 lg:p-10 aa-rise" style={{ animationDelay: '80ms' }}>
            <header className="mb-8 border-b border-slate-200 pb-6">
              <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight text-slate-900">Terminos y condiciones</h1>
              <p className="text-sm text-slate-500 mt-2">Ultima actualizacion: abril de 2026</p>
            </header>

            <div className="aa-stagger space-y-6 text-slate-700 leading-relaxed">
              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">1. Aceptacion de los terminos</h2>
                <p>
                  Al acceder o usar Valee, ya sea como comercio o como cliente final, aceptas estos terminos y condiciones en su totalidad. Si no estas de acuerdo con alguna parte, no debes utilizar la plataforma.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">2. Descripcion del servicio</h2>
                <p>
                  Valee es una plataforma de fidelizacion y recompensas para comercios. Los comercios pueden configurar un programa de puntos para sus clientes, cargar facturas, gestionar un catalogo de productos canjeables y procesar canjes mediante codigos QR. Los clientes pueden registrarse, acumular puntos validando facturas y canjearlos por productos del catalogo del comercio donde los acumularon.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">3. Cuentas de usuario</h2>
                <p>
                  Cada cliente se identifica por su numero de telefono. Cada comercio se identifica por su cuenta de comercio asignada por Valee. Eres responsable de mantener la confidencialidad de tus credenciales de acceso y de todas las actividades realizadas desde tu cuenta. Notifica a Valee inmediatamente si sospechas un acceso no autorizado.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">4. Puntos y canjes</h2>
                <p>
                  Los puntos acumulados por un cliente solo pueden canjearse en el comercio donde fueron acumulados. Los puntos no tienen valor monetario, no son transferibles entre cuentas y no son convertibles a dinero. El comercio define el valor de conversion entre el monto de la factura y los puntos otorgados, asi como el costo en puntos de cada producto del catalogo. Valee no garantiza la disponibilidad permanente de productos en el catalogo del comercio.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">5. Validacion de facturas</h2>
                <p>
                  Las facturas enviadas por los clientes son procesadas mediante reconocimiento optico de caracteres y verificadas contra los registros del comercio. Una factura puede ser rechazada si no cumple con los criterios de validacion (numero duplicado, datos no coincidentes, monto fuera de tolerancia, etc). Valee no se responsabiliza por facturas mal escaneadas, ilegibles o que el comercio no haya cargado en su sistema.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">6. Conducta del usuario</h2>
                <p>Esta prohibido:</p>
                <ul className="list-disc pl-6 space-y-1 mt-2">
                  <li>Enviar facturas falsas, alteradas o que no correspondan a una compra real.</li>
                  <li>Crear multiples cuentas con el mismo numero de telefono o cedula.</li>
                  <li>Intentar manipular el sistema de puntos o de canjes por medios fraudulentos.</li>
                  <li>Usar la plataforma para fines distintos de los previstos en estos terminos.</li>
                </ul>
                <p className="mt-2">
                  El incumplimiento de estas reglas puede resultar en la suspension o eliminacion de la cuenta y la perdida del saldo acumulado.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">7. Responsabilidad del comercio</h2>
                <p>
                  Cada comercio es responsable de la veracidad de los datos que carga en la plataforma, del cumplimiento de las leyes fiscales y comerciales aplicables a su negocio, y de honrar los canjes que sus clientes generen en su programa de fidelizacion.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">8. Limitacion de responsabilidad</h2>
                <p>
                  Valee se proporciona tal como esta. No garantizamos disponibilidad ininterrumpida del servicio. No somos responsables por perdidas indirectas, lucro cesante o danos derivados del uso o imposibilidad de uso de la plataforma. Nuestra responsabilidad maxima frente a un comercio se limita al monto pagado por el comercio en los ultimos 30 dias por el servicio.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">9. Modificaciones</h2>
                <p>
                  Valee puede actualizar estos terminos periodicamente. Los cambios significativos se comunicaran a los comercios registrados con al menos 7 dias de anticipacion. El uso continuado de la plataforma despues de un cambio implica la aceptacion de los nuevos terminos.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">10. Contacto</h2>
                <p>
                  Para cualquier consulta sobre estos terminos puedes contactarnos a traves del comercio donde te registraste o visitando <Link href="/" className="text-emerald-700 underline hover:text-emerald-800">valee.app</Link>. Para asuntos de privacidad y manejo de datos personales consulta nuestra <Link href="/privacy" className="text-emerald-700 underline hover:text-emerald-800">politica de privacidad</Link>.
                </p>
              </section>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-8 text-center text-sm font-medium text-slate-500 space-x-6">
        <Link
          href="/"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Inicio
        </Link>
        <Link
          href="/admin/login"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Admin
        </Link>
        <Link
          href="/privacy"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Privacidad
        </Link>
      </footer>
    </div>
  )
}
