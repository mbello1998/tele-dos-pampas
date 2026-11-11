'use client'

import { useRef, useState, useTransition } from 'react'
import { moveCall, type CallError } from '@/actions/motoboy'
import { formatMoney, type Locale } from '@/lib/money/format'
import type { CourierCopy } from './copy'
import type { Call, Place } from './types'

const display = 'font-[family-name:var(--font-display)] font-extrabold uppercase'

const formatDistance = (m: number): string =>
  m < 1000 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`

function Where({ label, place, tag, copy }: { label: string; place: Place; tag?: string | null; copy: CourierCopy }) {
  const street = [place.street, place.number].filter(Boolean).join(', ')
  return (
    <div>
      <div className="flex items-baseline gap-2 text-base leading-snug text-white/85">
        <span className="w-9 shrink-0 text-xs font-bold uppercase tracking-wider text-white/55">{label}</span>
        <span className="min-w-0 break-words font-medium">
          {street || '—'}
          {tag ? <span className="ml-2 font-bold uppercase text-white">{tag}</span> : null}
        </span>
      </div>
      {place.reference ? (
        <div className="mt-1 rounded-md bg-white/10 px-2.5 py-1 text-[1.0625rem] font-bold leading-snug text-white" data-testid="reference">
          <span className="mr-1.5 text-xs font-bold uppercase tracking-wider text-white/55">{copy.ref}</span>
          {place.reference}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One call. The order of what the eye meets, top to bottom: the bridge band (if any), WHO is calling and what it
 * PAYS (the two things that decide "is it worth it", side by side and the biggest on the card), how far, then the
 * pickup and drop-off with the landmark, then the one big button. Nothing else.
 */
export function CallRow({
  call, copy, locale, distanceM, nowMs, mine, onError,
}: {
  call: Call
  copy: CourierCopy
  locale: Locale
  distanceM: number | null
  nowMs: number
  mine: boolean
  onError: (error: CallError) => void
}) {
  const [pending, startTransition] = useTransition()
  // A synchronous guard: `pending` only turns true after a render, and a gloved double tap lands before that.
  const busy = useRef(false)
  const [tapped, setTapped] = useState<string | null>(null)

  const press = (to: string) => {
    if (busy.current) return
    busy.current = true
    setTapped(to)
    startTransition(async () => {
      try {
        const result = await moveCall(call.id, to, call.status)
        if (!result.ok) onError(result.error)
      } catch {
        onError('failed')
      } finally {
        busy.current = false
        setTapped(null)
      }
    })
  }

  const minutes = Math.max(0, Math.floor((nowMs - call.createdAtMs) / 60_000))
  const kindLabel = call.kind === 'ride' ? copy.kind_ride : call.kind === 'courier' ? copy.kind_courier : copy.kind_delivery
  // A person's name is not shown before the claim: the headline then says what the call IS.
  const headline = call.requesterName ?? kindLabel
  const labelFor = (to: string) => (copy as unknown as Record<string, string>)[`step_${to}`] ?? to
  const buttons = mine ? call.steps : call.acceptTo ? [call.acceptTo] : []

  return (
    <article
      className={`overflow-hidden rounded-xl border-2 bg-white/[0.05] ${call.crossesBorder ? 'border-brasa' : mine ? 'border-sol' : 'border-rio/70'}`}
      data-testid="call"
      data-code={call.code}
      data-kind={call.kind}
      data-crosses={call.crossesBorder ? 'true' : 'false'}
    >
      {call.crossesBorder ? (
        <div className={`${display} bg-brasa px-3 py-1.5 text-xl leading-none tracking-wide text-white`} data-testid="bridge">
          {copy.bridge}
          {call.crossesTo ? <span className="ml-2 opacity-90">→ {call.crossesTo}</span> : null}
        </div>
      ) : null}

      <div className="px-3 pb-3 pt-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className={`${display} break-words text-[1.75rem] leading-[1.02] text-white`} data-testid="who">
              {headline}
            </h2>
            <p className="mt-1 text-sm font-medium text-white/70">
              {call.requesterName ? `${kindLabel} · ` : ''}
              <span className={minutes >= 10 ? 'font-bold text-brasa' : ''}>
                {minutes < 1 ? copy.ago_now : copy.ago_min(minutes)}
              </span>
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className={`${display} preco text-[2.25rem] leading-none text-sol`} data-testid="fee">
              {call.fee === null ? '—' : formatMoney(call.fee, 'BRL', locale)}
            </div>
            {distanceM !== null ? (
              <div className="mt-1 text-base font-bold leading-none text-white" data-testid="distance" aria-label={copy.away(formatDistance(distanceM))}>
                {formatDistance(distanceM)}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-2.5 flex flex-col gap-2">
          <Where label={copy.from} place={call.pickup} copy={copy} />
          <Where label={copy.to} place={call.dropoff} tag={call.crossesBorder ? call.crossesTo : null} copy={copy} />
        </div>

        {mine && call.collect ? (
          <p className="mt-3 text-base font-bold text-white" data-testid="collect">
            {copy.collect_cash(formatMoney(call.collect.amount, call.collect.currency, locale))}
            {call.collect.changeFor !== null ? (
              <span className="ml-1 font-medium text-white/70">
                ({copy.collect_change(formatMoney(call.collect.changeFor, call.collect.currency, locale))})
              </span>
            ) : null}
          </p>
        ) : null}

        {buttons.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-2">
            {buttons.map((to, i) => (
              <button
                key={to}
                type="button"
                onClick={() => press(to)}
                disabled={pending}
                data-testid={mine ? 'step' : 'accept'}
                data-to={to}
                className={`${display} min-h-16 w-full rounded-xl text-[1.75rem] leading-none tracking-wide transition-transform active:scale-[0.98] disabled:opacity-60 ${
                  i === 0 ? 'bg-sol text-noite' : 'border-2 border-white/30 text-white'
                }`}
              >
                {pending && tapped === to ? copy.accepting : mine ? labelFor(to) : copy.accept}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}
