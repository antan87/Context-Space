import { AlertCircle, Check, Info, X } from 'lucide-react';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  duration?: number;
}

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (toastId: string) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-3 pointer-events-none max-w-md w-full">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start justify-between gap-3 rounded-xl border px-4 py-3 shadow-sm transition-all duration-300 animate-rise ${
            toast.type === 'success'
              ? 'border-success/32 bg-success/10 text-success-foreground'
              : toast.type === 'error'
                ? 'border-destructive/32 bg-destructive/10 text-destructive-foreground'
                : 'border-info/32 bg-info/10 text-info-foreground'
          }`}
        >
          <div className="flex items-start gap-2.5 text-xs font-semibold flex-1">
            {toast.type === 'success' && <Check className="mt-0.5 shrink-0 text-success" size={16} />}
            {toast.type === 'error' && <AlertCircle className="mt-0.5 shrink-0 text-destructive" size={16} />}
            {toast.type === 'info' && <Info className="mt-0.5 shrink-0 text-info" size={16} />}
            <span className="whitespace-pre-line text-left leading-relaxed">{toast.message}</span>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            className="mt-0.5 shrink-0 cursor-pointer rounded-sm p-1 -m-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
