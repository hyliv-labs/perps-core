import { useEffect, useRef } from 'react'

/**
 * A panel hung under the top bar.
 *
 * It exists so a control can be reachable from every state without any
 * screen having to give up room for it — the trading floor in particular,
 * which hid the connection panel to win back its height and left someone
 * already trading on a clear connection with no way to reach Tor or Nym.
 *
 * Closes on Escape and on a click outside, and takes focus when it opens so
 * the keyboard follows the mouse. Nothing here traps focus: the panel is
 * short, and a trap that cannot be escaped is worse than none.
 */
export function Popover({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: React.ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target || panel.current?.contains(target)) return
      // The button that opened this is outside the panel, and clicking it
      // again should toggle rather than close-then-reopen.
      if ((target as Element).closest?.('.bar-connection')) return
      onClose()
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  return (
    <div
      className="popover"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      ref={panel}
    >
      {children}
      <div className="actions">
        <button className="quiet" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
