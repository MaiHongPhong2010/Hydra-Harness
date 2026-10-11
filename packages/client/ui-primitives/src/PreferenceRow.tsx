/** Scalar preference chrome with acknowledged saves and responsive controls. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Switch } from './Switch.tsx'
import css from './PreferenceRow.module.css'

/** Presentation and an owner-supplied scalar mutation. */
export interface PreferenceRowProps {
  title: string
  description: string
  value: string | boolean
  disabled?: boolean | undefined
  options?: readonly { value: string; label: string; disabled?: boolean | undefined }[] | undefined
  onChange: (value: string | boolean) => Promise<void>
  savingLabel: string
  appliesLabel: string
  children?: ReactNode
  details?: ReactNode
}

/**
 * Render a scalar control; the owner supplies accepted state and performs validation and persistence.
 * @param props - label, accepted value, available choices, and owning mutation.
 * @returns the preference row and save feedback.
 */
export function PreferenceRow({ title, description, value, disabled, options, onChange, savingLabel, appliesLabel,
  children, details }: PreferenceRowProps) {
  const id = useId()
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const change = (next: string | boolean): void => {
    if (disabled || pending.current) return
    pending.current = true
    setSaving(true)
    setSaved(false)
    setError(undefined)
    void onChange(next).then(() => { setSaved(true) }, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => { pending.current = false; setSaving(false) })
  }
  const blocked = disabled || saving
  return <div className={css.row}>
    <div className={css.text}>
      <label htmlFor={id} className={css.title}>{title}</label>
      <div id={`${id}-description`} className={css.description}>{description}{details}</div>
      {saving && <div role="status" className={css.description}>{savingLabel}</div>}
      {saved && <div role="status" className={css.description}>{appliesLabel}</div>}
      {error !== undefined && <div role="alert" className={css.error}>{error}</div>}
    </div>
    <div className={css.control}>
      {typeof value === 'boolean'
        ? <Switch id={id} checked={value} disabled={blocked} aria-describedby={`${id}-description`}
          onClick={() => { change(!value) }} />
        : options !== undefined
          ? <select id={id} data-hydra-control="field" value={value} disabled={blocked}
            aria-describedby={`${id}-description`} onChange={(event) => { change(event.target.value) }}>
            {!options.some(option => option.value === value) && <option value={value} disabled>{value}</option>}
            {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
          </select>
          : <input id={id} data-hydra-control="field" value={draft} disabled={blocked}
            aria-describedby={`${id}-description`} onChange={(event) => { setDraft(event.target.value) }}
            onBlur={() => { if (draft !== value) change(draft) }} />}
      {children}
    </div>
  </div>
}
