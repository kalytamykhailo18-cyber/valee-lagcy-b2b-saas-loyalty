import Link from 'next/link'

export const metadata = {
  title: 'Politica de privacidad - Valee',
  description: 'Politica de privacidad de Valee, plataforma de fidelizacion para comercios.',
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen flex flex-col bg-emerald-50">
      <header className="py-6 text-center">
        <Link
          href="/"
          className="inline-block text-3xl font-extrabold tracking-tight text-emerald-700 hover:text-emerald-800 transition-colors"
        >
          Valee
        </Link>
      </header>

      <main className="flex-1">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 lg:p-10">
            <header className="mb-8 border-b border-slate-200 pb-6">
              <h1 className="text-3xl lg:text-4xl font-bold text-slate-900">Politica de privacidad</h1>
              <p className="text-sm text-slate-500 mt-2">Ultima actualizacion: abril de 2026</p>
            </header>

            <div className="space-y-6 text-slate-700 leading-relaxed">
              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">1. Quienes somos</h2>
                <p>
                  Valee es una plataforma de fidelizacion y recompensas para comercios. Permite a los comercios premiar a sus clientes con puntos por sus compras, y a los clientes canjear esos puntos por productos del catalogo del comercio. Esta politica describe que datos recogemos, para que los usamos y como los protegemos.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">2. Datos que recogemos</h2>
                <p>Recogemos unicamente los datos minimos necesarios para que la plataforma funcione:</p>
                <ul className="list-disc pl-6 space-y-1 mt-2">
                  <li>Numero de telefono del cliente, usado para crear su cuenta y enviar codigos de verificacion.</li>
                  <li>Cedula de identidad, opcional, solo cuando el cliente desea verificar su cuenta.</li>
                  <li>Imagenes de facturas que el cliente envia voluntariamente para acreditar puntos.</li>
                  <li>Historial de transacciones y canjes asociados al cliente.</li>
                  <li>Datos de contacto del comercio que se registra en la plataforma.</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">3. Uso de los datos</h2>
                <p>Los datos recogidos se utilizan exclusivamente para:</p>
                <ul className="list-disc pl-6 space-y-1 mt-2">
                  <li>Operar el sistema de fidelizacion (acreditar puntos, procesar canjes, validar facturas).</li>
                  <li>Comunicar al cliente el estado de sus puntos, validaciones y promociones via WhatsApp.</li>
                  <li>Prevenir fraude y abusos en la plataforma.</li>
                  <li>Generar reportes agregados para el comercio sobre su programa de fidelizacion.</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">4. Comunicaciones por WhatsApp</h2>
                <p>
                  Valee utiliza la API oficial de WhatsApp Business de Meta para enviar mensajes transaccionales, notificaciones de puntos y promociones a los clientes que se registran voluntariamente en la plataforma. El cliente puede solicitar dejar de recibir mensajes en cualquier momento contactando al comercio o respondiendo al chat.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">5. Almacenamiento y seguridad</h2>
                <p>
                  Los datos se almacenan en servidores cifrados con acceso restringido. Las imagenes de facturas se procesan automaticamente y se almacenan unicamente para auditoria. Las contrasenas y tokens de acceso estan cifrados con algoritmos estandar de la industria. No vendemos ni compartimos datos personales con terceros con fines comerciales.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">6. Derechos del cliente</h2>
                <p>
                  Cualquier cliente puede solicitar acceso, correccion o eliminacion de sus datos personales contactando al comercio donde se registro o escribiendo al equipo de Valee. La eliminacion de la cuenta implica la perdida del saldo de puntos acumulado.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">7. Cambios en esta politica</h2>
                <p>
                  Esta politica puede actualizarse periodicamente. La fecha de la ultima actualizacion se indica al inicio del documento. Los cambios significativos seran comunicados a los comercios registrados en la plataforma.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">8. Contacto</h2>
                <p>
                  Para cualquier consulta sobre esta politica de privacidad o sobre el manejo de datos personales, puedes contactarnos a traves del comercio donde te registraste o visitando <Link href="/" className="text-emerald-700 underline hover:text-emerald-800">valee.app</Link>.
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
          href="/merchant/login"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Acceso comercio
        </Link>
        <Link
          href="/admin/login"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Admin
        </Link>
        <Link
          href="/terms"
          className="hover:text-emerald-700 hover:underline underline-offset-4 transition-colors"
        >
          Terminos
        </Link>
      </footer>
    </div>
  )
}
