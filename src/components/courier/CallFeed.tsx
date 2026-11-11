'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CallError } from '@/actions/motoboy'
import { haversineMeters } from '@/lib/geo/distance'
import type { LatLng } from '@/lib/geo/types'
import type { Locale } from '@/lib/money/format'
import { CallRow } from './CallRow'
import { courierCopy } from './copy'
import type { Call } from './types'

const REFRESH_MS = 12_000
const display = 'font-[family-name:var(--font-display)] font-extrabold uppercase'

/**
 * The feed. The server decides what exists (the courier's city, the bridge and passenger boundaries, the calls
 * already theirs); this decides what is NEAR, because only the phone knows where the courier is. The radius it
 * filters with is the one in force (my_effective_radius_km), never the stored preference.
 * Newest first: the order calls arrived, which does not jump around while the GPS wobbles.
 */
export function CallFeed({
  queue, mine, radiusKm, serverNow, locale, loadFailed,
}: {
  queue: Call[]
  mine: Call[]
  radiusKm: number | null
  serverNow: number
  locale: Locale
  loadFailed: boolean
}) {
  const copy = courierCopy(locale)
  const router = useRouter()
  const [here, setHere] = useState<LatLng | null>(null)
  const [gpsOff, setGpsOff] = useState(false)
  const [notice, setNotice] = useState<CallError | null>(null)

  // Position: watched, not polled, and never sent anywhere from here.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsOff(true)
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGpsOff(false)
        setHere({ lat: p.coords.latitude, lng: p.coords.longitude })
      },
      () => setGpsOff(true),
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // New calls arrive on their own: the screen sits on a handlebar mount and nobody pulls to refresh.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh()
    }
    const id = window.setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [router])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 9_000)
    return () => window.clearTimeout(id)
  }, [notice])

  const onError = useCallback(
    (error: CallError) => {
      setNotice(error)
      // The call is gone (another courier took it first): drop it from the screen now.
      if (error === 'gone') router.refresh()
    },
    [router],
  )

  const distanceTo = useCallback(
    (c: Call): number | null => {
      if (!here || c.pickup.lat === null || c.pickup.lng === null) return null
      return haversineMeters(here, { lat: c.pickup.lat, lng: c.pickup.lng })
    },
    [here],
  )

  const { visible, outside } = useMemo(() => {
    const sorted = [...queue].sort((a, b) => b.createdAtMs - a.createdAtMs)
    if (radiusKm === null || !here) return { visible: sorted, outside: 0 }
    const near = sorted.filter((c) => {
      const d = distanceTo(c)
      return d === null || d <= radiusKm * 1000
    })
    return { visible: near, outside: sorted.length - near.length }
  }, [queue, radiusKm, here, distanceTo])

  const noticeText = notice ? (copy as unknown as Record<string, string>)[`err_${notice}`] ?? copy.err_failed : null

  return (
    <div>
      <header className="flex items-end justify-between gap-3 pb-3">
        <h1 className={`${display} text-[2rem] leading-none text-white`}>{copy.title}</h1>
        <p
          className={`${display} text-[2rem] leading-none ${visible.length > 0 ? 'text-sol' : 'text-white/55'}`}
          data-testid="count"
          aria-live="polite"
        >
          {visible.length > 0 ? copy.count(visible.length) : ''}
        </p>
      </header>

      {noticeText ? (
        <p role="alert" className="mb-3 rounded-lg border-2 border-brasa bg-brasa/20 px-3 py-3 text-base font-bold text-white" data-testid="notice">
          {noticeText}
        </p>
      ) : null}
      {loadFailed ? (
        <p role="alert" className="mb-3 rounded-lg border-2 border-brasa bg-brasa/20 px-3 py-3 text-base font-bold text-white">
          {copy.err_load}
        </p>
      ) : null}

      {mine.length > 0 ? (
        <section aria-label={copy.mine_title} className="mb-5">
          <h2 className={`${display} mb-2 text-xl leading-none tracking-wide text-sol`}>{copy.mine_title}</h2>
          <div className="flex flex-col gap-3">
            {mine.map((c) => (
              <CallRow key={c.id} call={c} copy={copy} locale={locale} distanceM={distanceTo(c)} nowMs={serverNow} mine onError={onError} />
            ))}
          </div>
        </section>
      ) : null}

      {mine.length > 0 ? <h2 className={`${display} mb-2 text-xl leading-none tracking-wide text-white/70`}>{copy.queue_title}</h2> : null}

      {visible.length === 0 && !loadFailed ? (
        <div className="rounded-xl border-2 border-white/15 px-4 py-10 text-center" data-testid="empty">
          <p className={`${display} text-[2.25rem] leading-none text-white`}>{copy.none}</p>
          <p className="mt-3 text-base text-white/70">{copy.none_hint}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="queue">
          {visible.map((c) => (
            <CallRow key={c.id} call={c} copy={copy} locale={locale} distanceM={distanceTo(c)} nowMs={serverNow} mine={false} onError={onError} />
          ))}
        </div>
      )}

      <footer className="mt-5 space-y-1 text-sm text-white/65">
        {gpsOff ? <p data-testid="no-gps">{copy.no_gps}</p> : null}
        {outside > 0 ? <p data-testid="outside">{copy.outside(outside)}</p> : null}
        {radiusKm !== null ? <p>{copy.radius(String(radiusKm).replace('.', ','))}</p> : null}
      </footer>
    </div>
  )
}
