'use client'

import { useState, useEffect } from 'react'
import { MdCardGiftcard, MdChevronLeft, MdChevronRight } from 'react-icons/md'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { getCurrentSessionIdentity, maskPhone } from '@/lib/session-identity'

interface MerchantAccount {
	accountId: string
	tenantId: string
	tenantName: string
	tenantSlug: string
	balance: string
	unitLabel: string
	topProducts: Array<{ id: string; name: string; photoUrl: string | null; redemptionCost: string; stock: number }>
}

interface AffiliatedMerchant {
	id: string
	name: string
	slug: string
	qrCodeUrl: string | null
	logoUrl?: string | null
	tenantLogoUrl?: string | null
}

export default function Home() {
	const router = useRouter()
	const [loading, setLoading] = useState(true)
	const [affiliated, setAffiliated] = useState<AffiliatedMerchant[]>([])
	const [currentMerchantSlide, setCurrentMerchantSlide] = useState(0)
	const [hasSession, setHasSession] = useState(false)
	const [sessionPhone, setSessionPhone] = useState<string | null>(null)
	const faqData = [
		{
			question: "¿Tengo que descargar alguna aplicación?",
			answer: "No. Esa es la magia de Valee. Todo el proceso de registro, envío de facturas y consulta de puntos se realiza directamente a través de WhatsApp. No necesitas sacrificar memoria en tu teléfono ni aprender a usar una interfaz nueva."
		},
		{
			question: "Soy dueño de un negocio, ¿es difícil integrarlo?",
			answer: "Para nada. Valee funciona de forma externa a tu punto de venta (POS). Solo necesitas registrar tu comercio, configurar tus premios y empezar a invitar a tus clientes. No requiere instalación de hardware ni cambios en tu software actual."
		},
		{
			question: "¿Qué tan seguros están mis datos?",
			answer: "La privacidad es nuestra prioridad. Solo procesamos la información necesaria para validar tus compras y asignar tus recompensas. Tus datos están protegidos y nunca los compartimos con terceros sin tu consentimiento."
		},
		{
			question: "¿Qué pasa si el sistema no reconoce mi factura?",
			answer: "Si la foto es borrosa o falta información, nuestro sistema te notificará por WhatsApp al instante para que puedas enviarla de nuevo. Además, contamos con un equipo de soporte listo para ayudarte si surge cualquier inconveniente."
		}
	];
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	// Definimos cuántos queremos ver por vista
	const itemsPerPage = 6;
	const totalPages = Math.ceil(affiliated.length / itemsPerPage);

	// Ajuste del auto-play para que use totalPages
	useEffect(() => {
		if (totalPages <= 1 || loading) return;
	
		const timer = setInterval(() => {
			setCurrentMerchantSlide((prev) => (prev + 1) % totalPages);
		}, 3500);
	
		return () => clearInterval(timer);
	}, [totalPages, loading]);

	// Funciones para los botones de flechas
	const nextSlide = () => {
		setCurrentMerchantSlide((prev) => (prev + 1) % totalPages);
	};
	const prevSlide = () => {
		setCurrentMerchantSlide((prev) => (prev - 1 + totalPages) % totalPages);
	};

	useEffect(() => {
		
		// `/` is ALWAYS the public landing page now. It does not auto-switch to
		// an authenticated view — that used to cause valee.app to open straight
		// into someone else's consumer dashboard on a shared computer. The
		// multicommerce hub lives at /consumer. We just record whether the user
		// has a session so we can swap the CTA copy from "Ya tengo cuenta" to
		// "Mi cuenta". When a session exists we also surface the phone number
		// (masked) so the user knows WHICH account they'll enter before clicking.
		if (typeof window !== 'undefined') {
			const token = localStorage.getItem('consumerAccessToken') || localStorage.getItem('accessToken')
			setHasSession(!!token)
			if (token) {
				const ident = getCurrentSessionIdentity()
				setSessionPhone(ident?.phoneNumber || null)
			}
		}
		; (async () => {
			try {
				const aff = await api.getAffiliatedMerchants()
				setAffiliated(aff.merchants)
			} catch { }
			setLoading(false)
		})()

		
	}, [])

	useEffect(() => {
		if (affiliated.length === 0) return
		if (currentMerchantSlide > affiliated.length - 1) {
			setCurrentMerchantSlide(0)
		}
	}, [affiliated.length, currentMerchantSlide])

	useEffect(() => {
		if (affiliated.length <= 1) return
		const timer = setInterval(() => {
			setCurrentMerchantSlide(prev => (prev + 1) % affiliated.length)
		}, 3500)
		return () => clearInterval(timer)
	}, [affiliated.length])

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-slate-50">
				<div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
			</div>
		)
	}

	

	// ============================================================
	// PUBLIC — Welcoming landing (always shown; session-aware CTA)
	// ============================================================
	return (
		<div className="min-h-screen">
			{/* Header */}
			<header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-100">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-20">

						{/* Logo */}
						<div className="flex-shrink-0 flex items-center gap-2">
							<div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
								{/* Replace with your actual Appline SVG icon */}
								<span className="text-white font-bold text-xl">V</span>
							</div>
							<span className="text-2xl font-bold text-slate-900 tracking-tight">Valee</span>
						</div>

						{/* Right side actions buttons */}
						<div className="flex items-center space-x-5">
							<Link href="/consumer" className="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold shadow-sm transition-all">
								<span className="relative z-10">
									{hasSession
										? (sessionPhone ? `Entrar como ${maskPhone(sessionPhone)}` : 'Mi cuenta')
										: 'Ya tengo cuenta'}
								</span>
							</Link>
							{hasSession && (
								<Link href="/consumer?switch=1" className="block text-xs text-indigo-100 hover:text-white mt-3 underline">
									No soy yo — cambiar de cuenta
								</Link>
							)}
						</div>

					</div>
				</div>
			</header>
			{/* Hero */}
			<main className="relative overflow-hidden bg-white pt-[100px] pb-[0px] lg:pt-[100px]">
				<div className="container max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">

						{/* Left Column: Text Content */}
						<div className="max-w-[570px]">
							<span className="block text-base font-semibold text-slate-800 mb-4 aa-rise">
								Cada Negocio Cuenta
							</span>
							<h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-slate-900 leading-[1.1] mb-6 aa-rise" style={{ animationDelay: '0.s1', animationFillMode: 'both' }}>
								Tus facturas de compra ahora son <span className="text-indigo-400">Recompensas</span>.
							</h1>
							<p className="text-lg text-gray-500 leading-relaxed mb-10 aa-rise" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
								Gana puntos en tus comercios favoritos enviando una foto de tu facturas por WhatsApp. Sin apps, sin registros eternos, solo beneficios.
							</p>

							{/* CTA Buttons */}
							<div className="flex flex-wrap items-center gap-5">
								<Link
									href="/consumer"
									className="inline-flex items-center gap-3 bg-[#1D2130] text-white px-8 py-4 rounded-lg font-semibold hover:bg-slate-800 transition-all shadow-lg aa-rise"
									style={{ animationDelay: '0.3s', animationFillMode: 'both' }}
								>
									Empezar a ganar
									<span className="border-l border-white/20 pl-3">
										<svg
											width="24"
											height="24"
											viewBox="0 0 24 24"
											fill="none"
											xmlns="http://www.w3.org/2000/svg"
											className="w-5 h-5"
										>
											<path
												d="M17 2H7C5.89543 2 5 2.89543 5 4V20C5 21.1046 5.89543 22 7 22H17C18.1046 22 19 21.1046 19 20V4C19 2.89543 18.1046 2 17 2Z"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
											<path
												d="M12 18H12.01"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
											<path
												d="M10 4H14"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</span>
								</Link>

								<button className="group flex items-center gap-4 text-slate-900 font-semibold aa-rise" style={{ animationDelay: '0.4s', animationFillMode: 'both' }}>
									<div className="w-14 h-14 flex items-center justify-center rounded-full border-2 border-slate-100 group-hover:bg-indigo-50 group-hover:border-indigo-100 transition-all">
										<svg className="w-5 h-5 text-slate-900 fill-current" viewBox="0 0 24 24">
											<path d="M8 5v14l11-7z" />
										</svg>
									</div>
									<div className="flex flex-col items-start">
										<span className="text-sm">Ver</span>
										<span className="text-xs text-gray-400 font-normal underline">Ver cómo funciona</span>
									</div>
								</button>
							</div>
						</div>

						{/* Right Column: Image Mockup */}
						<div className="relative flex justify-center lg:justify-end">
							{/* Decorative background circle */}
							<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] bg-indigo-50 rounded-full -z-10 opacity-60 blur-3xl"></div>

							<div className="relative w-full max-w-[650px]">
								{/* Image */}
								<img
									src="/images/image-1.png"
									alt="App Interface"
									className="w-full h-auto"
								/>

								{/* Floating stars/decorations if you want to match the image exactly */}
								<div className="absolute -top-10 -right-5 text-indigo-400">✦</div>
								<div className="absolute top-20 -right-10 text-emerald-400">✦</div>
							</div>
						</div>

					</div>
				</div>
			</main>

			{/* Businness Carousel */}
			<section className="pt-10 pb-20 bg-white">
				<div className="container max-w-7xl mx-auto px-4 sm:px-6 lg:px-6">
					<div className="relative">
						{totalPages > 1 && (
							<>
								<button
									type="button"
									onClick={prevSlide}
									className="absolute -left-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-white hover:border hover:border-slate-200 flex items-center justify-center text-slate-600 hover:text-indigo-600 transition"
								>
									<MdChevronLeft className="w-6 h-6" />
								</button>
								<button
									type="button"
									onClick={nextSlide}
									className="absolute -right-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-white hover:border hover:border-slate-200 flex items-center justify-center text-slate-600 hover:text-indigo-600 transition"
								>
									<MdChevronRight className="w-6 h-6" />
								</button>
							</>
						)}

						<div className="overflow-hidden">
							<div
								className="flex transition-transform duration-500 ease-out"
								
								style={{ transform: `translateX(-${currentMerchantSlide * 100}%)` }}
							>
								{affiliated.map(m => (
									<div key={m.id} className="w-full flex-shrink-0 px-2 lg:w-1/6">
										<div className="bg-gray-50 rounded-[30px] border border-gray-100 p-6 flex flex-col items-center justify-center min-h-[160px]">
											{(m.logoUrl || m.tenantLogoUrl) ? (
												<img
													src={m.logoUrl || m.tenantLogoUrl || ''}
													alt={m.name}
													className="max-h-12 sm:max-h-16 w-auto object-contain"
												/>
											) : (
												<span className="text-2xl font-bold text-slate-500">{m.name.charAt(0)}</span>
											)}
											<p className="mt-3 text-xs sm:text-sm font-semibold text-slate-700 text-center">{m.name}</p>
										</div>
									</div>
								))}
							</div>
						</div>

						{/* Dots generados por cantidad de PÁGINAS, no de negocios */}
						{totalPages > 1 && (
							<div className="mt-8 flex justify-center gap-2">
								{Array.from({ length: totalPages }).map((_, idx) => (
									<button
										key={idx}
										type="button"
										onClick={() => setCurrentMerchantSlide(idx)}
										className={`h-2 rounded-full transition-all ${
											idx === currentMerchantSlide 
											? 'w-6 bg-indigo-600' 
											: 'w-2 bg-slate-300 hover:bg-slate-400'
										}`}
										aria-label={`Ir a la página ${idx + 1}`}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			</section>

			<section className="py-20 bg-gray-50">
				<div className="container max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

					{/* Main Banner Container */}
					<div className="relative bg-white rounded-[40px] border border-gray-100 overflow-hidden p-8 sm:p-16 lg:p-24 flex flex-col lg:flex-row items-center gap-12">

						{/* Left Column: Content */}
						<div className="flex-1 text-center lg:text-left z-10">
							<h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-slate-900 leading-tight mb-6">
								Convierte una compra casual en un cliente recurrente.
							</h2>
							{/* Numbered List Items */}
							<div className="space-y-8 pb-10">
								<div className="flex gap-6">
									<div className="flex-shrink-0 w-12 h-12 rounded-full border border-gray-100 flex items-center justify-center text-slate-900 font-bold shadow-sm">
										01
									</div>
									<div>
										<h4 className="text-lg font-bold text-slate-900 mb-1">Sin aplicaciones extra</h4>
										<p className="text-gray-500">Olvídate de llenar la memoria de tu teléfono. Todo el proceso ocurre dentro de WhatsApp, la aplicación que ya usas y dominas cada día.</p>
									</div>
								</div>

								<div className="flex gap-6">
									<div className="flex-shrink-0 w-12 h-12 rounded-full border border-gray-100 flex items-center justify-center text-slate-900 font-bold shadow-sm">
										02
									</div>
									<div>
										<h4 className="text-lg font-bold text-slate-900 mb-1">Perfiles de usuario precisoso</h4>
										<p className="text-gray-500">Identifica a tus clientes más fieles y conoce su factura promedio de compra automáticamente.</p>
									</div>
								</div>
							</div>

							{/* Store Buttons */}
							<div className="flex flex-wrap justify-center lg:justify-start gap-4">
								<Link
									href="/merchant/signup"
									className="inline-flex items-center gap-3 bg-[#1D2130] text-white px-8 py-4 rounded-lg font-semibold hover:bg-slate-800 transition-all shadow-lg"
								>
									Registrar Comercio
									<span className="border-l border-white/20 pl-3">
										<svg
											width="24"
											height="24"
											viewBox="0 0 24 24"
											fill="none"
											xmlns="http://www.w3.org/2000/svg"
											className="w-5 h-5"
										>
											<path
												d="M17 2H7C5.89543 2 5 2.89543 5 4V20C5 21.1046 5.89543 22 7 22H17C18.1046 22 19 21.1046 19 20V4C19 2.89543 18.1046 2 17 2Z"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
											<path
												d="M12 18H12.01"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
											<path
												d="M10 4H14"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</span>
								</Link>

							</div>
						</div>

						{/* Right Column: Phone Mockup with Circular Gradient */}
						<div className="relative flex-1 flex justify-center lg:justify-end">
							{/* The large circular gradient seen in the reference */}
							<div className="absolute top-1/2 left-1/2 lg:left-2/3 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] sm:w-[450px] sm:h-[450px] bg-gradient-to-tr from-[#FF9F9F] via-[#FFD18B] to-[#7B8FF7] rounded-full opacity-60 blur-2xl -z-10"></div>

							<div className="relative w-full max-w-[320px] lg:max-w-[500px]">
								<img
									src="/images/image-2.png"
									alt="App Interface Final Preview"
									className="w-full h-auto drop-shadow-3xl"
								/>
								{/* Star Decorations */}
								<div className="absolute top-10 -right-4 text-indigo-400 text-2xl animate-pulse">✦</div>
								<div className="absolute top-20 -right-12 text-emerald-400 text-xl">✦</div>

								{/* Wave Decoration at the bottom left of phone */}
								<div className="absolute -left-10 bottom-10 opacity-60">
									<svg width="60" height="30" viewBox="0 0 60 30" fill="none">
										<path d="M0 15C5 15 5 20 10 20C15 20 15 15 20 15C25 15 25 20 30 20C35 20 35 15 40 15C45 15 45 20 50 20C55 20 55 15 60 15" stroke="#FF9F9F" strokeWidth="3" strokeLinecap="round" />
										<path d="M0 5C5 5 5 10 10 10C15 10 15 5 20 5C25 5 25 10 30 10C35 10 35 5 40 5C45 5 45 10 50 10C55 10 55 5 60 5" stroke="#FF9F9F" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
									</svg>
								</div>
							</div>
						</div>

					</div>
				</div>
			</section>

			{/* Color cards */}
			<section className="py-20 bg-gray-50">
				<div className="container max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

					{/* Main Grid Container */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

						{/* Left column */}
						<div className="flex flex-col gap-8">

							{/* Green card */}
							<div className="bg-[#C4F2E4] rounded-[32px] p-8 sm:p-12 border border-gray-100 min-h-[300px] relative overflow-hidden flex items-center">
								
								<div className="max-w-[60%] z-10">
									<h3 className="text-[#0a7856] text-3xl sm:text-4xl font-bold mb-4 leading-tight">
										Gana sin esfuerzo
									</h3>
									<p className="text-[#0a7856]/90 text-lg">
										Envía una foto de tu factura por WhatsApp y nosotros hacemos el resto.
									</p>
								</div>
								
								<div className="absolute right-[-20px] bottom-0 w-1/2 h-full flex items-end justify-end p-4">
									<img src="/images/image-3.png" alt="Payment" className="max-h-[100%] object-contain" />
								</div>

							</div>

							{/* Salmon card */}
							<div className="bg-[#FFE3CD] rounded-[32px] p-8 sm:p-12 border border-gray-100 min-h-[300px] relative overflow-hidden flex items-center">
								
								<div className="max-w-[60%] z-10">
									<h3 className="text-[#ac642b] text-3xl sm:text-4xl font-bold mb-4 leading-tight">
										Tus puntos, al día
									</h3>
									<p className="text-[#ac642b]/90 text-lg">
										Consulta tu saldo y premios en tiempo real desde tu WhatsApp.
									</p>
								</div>
								
								<div className="absolute right-0 bottom-0 w-1/2 h-full flex items-end justify-end">
									<img src="/images/image-5.png" alt="Tracking" className="max-h-[90%] object-contain translate-y-4" />
								</div>

							</div>

						</div>

						{/* Right Column */}
						<div className="bg-[#D1E9FF] rounded-[32px] p-8 sm:p-12 border border-gray-100 min-h-[632px] relative overflow-hidden flex items-center">
							
							{/* Blue Card */}
							<div className="max-w-[70%] z-10">
								<h3 className="text-[#4888c2] text-4xl sm:text-5xl font-bold mb-6 leading-tight">
									+30 comercios aliados
								</h3>
								<p className="text-[#4888c2]/90 text-xl">
									Desde tu café diario hasta tus compras de moda. Elige dónde ganar hoy.
								</p>
							</div>
							
							<div className="absolute right-[-40px] bottom-0 w-3/5 h-full flex items-end justify-end">
								<img src="/images/image-4.png" alt="Categories" className="max-h-[80%] object-contain" />
							</div>

						</div>

					</div>
				</div>
			</section>

			<section className="py-24 bg-gray-50 relative overflow-hidden">
				{/* Decorative Background Elements */}
				<div className="absolute bottom-[-5%] left-[-5%] w-64 h-64 bg-indigo-100 rounded-full blur-3xl opacity-50 -z-10"></div>
				<div className="absolute top-[-5%] right-[-5%] w-48 h-48 bg-orange-100 rounded-full blur-3xl opacity-50 -z-10"></div>

				<div className="container max-w-3xl mx-auto px-4 sm:px-6">
					<div className="text-center mb-16">
						<h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-slate-900 mb-6">
							Preguntas Frecuentes
						</h2>
						<p className="text-gray-500 text-lg leading-relaxed">
							Todo lo que necesitas saber sobre cómo Valee está transformando la lealtad y las recompensas a través de WhatsApp.
						</p>
					</div>

					{/* FAQ Accordion Container */}
					<div className="bg-white rounded-3xl border border-gray-100 overflow-hidden">
						{faqData.map((item, index) => (
							<div key={index} className={`border-b border-gray-100 last:border-0`}>
								<button
									onClick={() => setOpenIndex(openIndex === index ? null : index)}
									className="w-full py-8 px-8 flex items-center justify-between text-left transition-colors hover:bg-gray-50/50"
								>
									<span className="text-slate-900 font-bold text-lg pr-4">
										{item.question}
									</span>
									<div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
										{openIndex === index ? (
											<span className="text-2xl text-slate-400">−</span>
										) : (
											<span className="text-2xl text-slate-400">+</span>
										)}
									</div>
								</button>

								{openIndex === index && (
									<div className="px-8 pb-8 animate-fadeIn">
										<p className="text-gray-500 leading-relaxed">
											{item.answer}
										</p>
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			</section>


			<footer className="bg-[#F8FAFC] pt-20 pb-10">
				<div className="container max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

					{/* Top Section: Branding and Links */}
					<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-12 mb-16">

						{/* Brand Column */}
						<div className="col-span-2 lg:col-span-2">
							<div className="flex items-center gap-2 mb-6">
								<div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center">
									<span className="text-white font-bold text-xl">V</span>
								</div>
								<span className="text-2xl font-bold text-slate-900 tracking-tight">Valee</span>
							</div>
							<p className="text-gray-500 max-w-xs leading-relaxed">
								La plataforma de lealtad inteligente que conecta a comercios y clientes a través de WhatsApp. Convierte cada factura en una oportunidad de ganar.
							</p>
						</div>

						{/* Quick Links Column */}
						<div>
							<h4 className="text-slate-900 font-bold mb-6">Inicio</h4>
							<ul className="space-y-4 text-gray-500 text-sm">
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Comercios Asociados</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">¿Cómo funciona?</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Beneficios para Negocios</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Preguntas Frecuentes</a></li>
							</ul>
						</div>

						{/* Resources Column */}
						<div>
							<h4 className="text-slate-900 font-bold mb-6">Soporte y Comunidad</h4>
							<ul className="space-y-4 text-gray-500 text-sm">
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Centro de Ayuda</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Canal de WhatsApp</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Directorio de Tiendas</a></li>
							</ul>
						</div>

						{/* Tutorial Column */}
						<div>
							<h4 className="text-slate-900 font-bold mb-6">Confianza</h4>
							<ul className="space-y-4 text-gray-500 text-sm">
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Política de Privacidad</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Términos y Condiciones</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Aviso de Cookies</a></li>
								<li><a href="#" className="hover:text-indigo-600 transition-colors">Contrato para Comercios</a></li>
							</ul>
						</div>
					</div>

					{/* Bottom Section: Sub-footer */}
					<div className="pt-8 border-t border-gray-200 flex flex-col md:flex-row justify-between items-center gap-6">
						<p className="text-gray-400 text-sm">
							© 2026 Valee.Todos los derechos reservados.
						</p>

						{/* Social Icons (Simplified) */}
						<div className="flex gap-6">
							<a href="#" className="text-gray-400 hover:text-indigo-600">Facebook</a>
							<a href="#" className="text-gray-400 hover:text-indigo-600">Twitter</a>
							<a href="#" className="text-gray-400 hover:text-indigo-600">LinkedIn</a>
						</div>

						<div className="flex gap-8 text-sm text-gray-400">
							<Link
								href="/privacy"
								className="hover:text-indigo-600 transition-colors"
							>
								Politica de Privacidad
							</Link>
							<Link
								href="/terms"
								className="hover:text-indigo-600 transition-colors"
							>
								Terminos y Condiciones
							</Link>
						</div>
					</div>

				</div>
			</footer>

		</div>
	)
}
