/**
 * React hook for detecting online/offline status.
 * Triggers a callback when the browser comes back online.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

export function useOnlineStatus(onReconnect?: () => void) {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect

  const handleOnline = useCallback(() => {
    setIsOnline(true)
    onReconnectRef.current?.()
  }, [])

  const handleOffline = useCallback(() => {
    setIsOnline(false)
  }, [])

  useEffect(() => {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [handleOnline, handleOffline])

  return isOnline
}
