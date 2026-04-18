// Client-side Sentry init for the Next.js PWA. No-op when DSN is unset so we
// can ship the SDK integrated and just flip an env var when the account exists.
import * as Sentry from '@sentry/nextjs'

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // Avoid noise from cancelled fetches / stale tokens in the consumer PWA.
    ignoreErrors: [
      'AbortError',
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
    ],
  })
}
