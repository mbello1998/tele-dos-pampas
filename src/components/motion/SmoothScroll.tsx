'use client'

import { useEffect } from 'react'
import { loadMotion } from '@/lib/motion/gsap'
import { startSmoothScroll } from '@/lib/motion/lenis'

/** Liga a rolagem suave (Lenis) quando permitido. Não renderiza nada. */
export function SmoothScroll() {
  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | undefined
    loadMotion()
      .then((motion) => startSmoothScroll(motion))
      .then((dispose) => {
        if (cancelled) dispose()
        else stop = dispose
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  return null
}
