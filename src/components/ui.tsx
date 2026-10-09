import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { type RepoState, STATE_LABEL } from '../lib/format.ts'

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner__dot" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  )
}

export function StatusBadge({ state }: { state: RepoState }) {
  return <span className={`badge badge--${state}`}>{STATE_LABEL[state]}</span>
}

/** A bar over real counters only; renders nothing meaningful without a total. */
export function Progress({ value, total, label }: { value: number; total: number; label: string }) {
  const ratio = total > 0 ? Math.min(1, value / total) : 0
  return (
    <div className="progress">
      <div className="progress__label">
        <span>{label}</span>
        <span className="progress__count">
          {value.toLocaleString()} / {total.toLocaleString()}
        </span>
      </div>
      <div className="progress__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
        <div className="progress__fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

export function Notice({ tone, title, children }: { tone: 'info' | 'warning' | 'danger' | 'success'; title?: string; children: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <p className="notice__title">{title}</p>}
      <div className="notice__body">{children}</div>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
    </div>
  )
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Notice tone="danger">
      <p>{error}</p>
      {onRetry && (
        <button type="button" className="button button--secondary button--small" onClick={onRetry}>
          Try again
        </button>
      )}
    </Notice>
  )
}

/** Destructive confirmation: the user must type the exact text to enable the action. */
export function ConfirmDialog({
  title,
  description,
  confirmText,
  actionLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  description: ReactNode
  confirmText: string
  actionLabel: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const ref = useRef<HTMLDialogElement>(null)
  const inputId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog ref={ref} className="dialog" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel() }}>
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (typed === confirmText && !busy) onConfirm()
        }}
      >
        <h2 className="dialog__title">{title}</h2>
        <div className="dialog__body">{description}</div>
        <label htmlFor={inputId} className="field__label">
          Type <code>{confirmText}</code> to confirm
        </label>
        <input id={inputId} className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoFocus />
        <div className="dialog__actions">
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button button--danger" disabled={typed !== confirmText || busy}>
            {busy ? 'Working…' : actionLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
