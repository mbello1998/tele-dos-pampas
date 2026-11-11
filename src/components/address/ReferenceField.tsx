'use client'

// Camada 3 do endereço: a referência em texto livre. Em cidade pequena é o que o entregador de fato
// usa para achar a casa, e aparece em destaque na tela dele, ACIMA do número. Por isso o rótulo diz
// ao cliente por que preencher, e não só "referência (opcional)".
import { useId } from 'react'
import type { Locale } from '@/lib/landing/content'

export const REFERENCE_MAX = 200

const COPY = {
  'pt-BR': {
    label: 'Ponto de referência',
    required: 'obrigatório',
    optional: 'opcional',
    why: 'O motoboy lê isto primeiro para achar sua casa. Diga o que ele vai ver: cor da casa, portão, vizinho, posto ou comércio por perto.',
    placeholder: 'Ex.: casa verde, do lado do posto',
    missing: 'Escreva uma referência: sem ela o motoboy pode não achar sua casa.',
  },
  'es-UY': {
    label: 'Punto de referencia',
    required: 'obligatorio',
    optional: 'opcional',
    why: 'El repartidor lee esto primero para encontrar tu casa. Decile qué va a ver: color de la casa, portón, vecino, estación de servicio o comercio cerca.',
    placeholder: 'Ej.: casa verde, al lado de la estación de servicio',
    missing: 'Escribí una referencia: sin ella el repartidor puede no encontrar tu casa.',
  },
} as const

export function referenceMissingMessage(locale: Locale): string {
  return COPY[locale].missing
}

type Props = {
  locale: Locale
  value: string
  onChange: (value: string) => void
  /** Obrigatória enquanto não há GPS: sem ele, a referência é o que resta para achar a casa. */
  required: boolean
  /** Mostra o erro de campo vazio (só depois de uma tentativa de salvar). */
  showError: boolean
}

export function ReferenceField({ locale, value, onChange, required, showError }: Props) {
  const c = COPY[locale]
  const uid = useId()
  const invalid = showError && required && value.trim() === ''
  return (
    <div className="grid gap-1">
      <label htmlFor={`${uid}-ref`} className="text-base font-semibold">
        {c.label} <span className="text-sm font-normal text-white/70">({required ? c.required : c.optional})</span>
      </label>
      <p id={`${uid}-why`} className="text-sm text-white/70">
        {c.why}
      </p>
      <textarea
        id={`${uid}-ref`}
        name="reference"
        rows={2}
        maxLength={REFERENCE_MAX}
        required={required}
        aria-required={required}
        aria-invalid={invalid}
        aria-describedby={`${uid}-why${invalid ? ` ${uid}-err` : ''}`}
        placeholder={c.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`min-h-11 w-full rounded-lg border bg-transparent px-3 py-2 text-base ${invalid ? 'border-brasa' : 'border-borda'}`}
      />
      {invalid && (
        <p id={`${uid}-err`} role="alert" className="text-sm text-brasa">
          {c.missing}
        </p>
      )}
    </div>
  )
}
