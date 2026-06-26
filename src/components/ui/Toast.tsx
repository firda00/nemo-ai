import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Check, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '../../lib/cn'

type Variant = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  message: string
  variant: Variant
}

const ToastCtx = createContext<(message: string, variant?: Variant) => void>(() => {})

const variantStyle: Record<Variant, { wrap: string; icon: ReactNode }> = {
  success: { wrap: 'border-forest/30', icon: <Check size={16} className="text-forest" /> },
  error: { wrap: 'border-danger/30', icon: <AlertTriangle size={16} className="text-danger" /> },
  info: { wrap: 'border-indigo/30', icon: <Info size={16} className="text-indigo" /> },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const remove = useCallback((id: number) => setItems((s) => s.filter((t) => t.id !== id)), [])

  const toast = useCallback(
    (message: string, variant: Variant = 'success') => {
      const id = ++idRef.current
      setItems((s) => [...s, { id, message, variant }])
      setTimeout(() => remove(id), 3200)
    },
    [remove],
  )

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[320px] max-w-[90vw] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-3 rounded-2xl border bg-panel px-4 py-3 shadow-lg animate-fadeInUp',
              variantStyle[t.variant].wrap,
            )}
          >
            {variantStyle[t.variant].icon}
            <span className="flex-1 text-sm text-text">{t.message}</span>
            <button onClick={() => remove(t.id)} className="text-muted hover:text-text">
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastCtx)
}
