import { useEffect, useState } from "react";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type: "success" | "error" | "info";
  // Optional call-to-action button (e.g. "Create free account" on the daily
  // limit toast). Action toasts stick around longer so the button is usable.
  action?: { label: string; onClick: () => void };
}

interface ToastProps {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}

function Toast({ toast, onDismiss }: ToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onDismiss(toast.id), 200);
    }, toast.action ? 8000 : 3000);

    return () => clearTimeout(timer);
  }, [toast.id, toast.action, onDismiss]);

  const iconColor = toast.type === "success"
    ? "text-emerald-400"
    : toast.type === "error"
    ? "text-red-400"
    : "text-blue-400";

  const bgColor = toast.type === "success"
    ? "bg-emerald-500/10 border-emerald-500/20"
    : toast.type === "error"
    ? "bg-red-500/10 border-red-500/20"
    : "bg-blue-500/10 border-blue-500/20";

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${bgColor} backdrop-blur-sm shadow-lg transition-all duration-200 ${
        isExiting ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
      }`}
    >
      {/* Icon */}
      <div className={`flex-shrink-0 ${iconColor}`}>
        {toast.type === "success" && (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        {toast.type === "error" && (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
        {toast.type === "info" && (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-[#a8a29e] mt-0.5">{toast.description}</p>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action!.onClick();
              setIsExiting(true);
              setTimeout(() => onDismiss(toast.id), 200);
            }}
            className="mt-1.5 px-2.5 py-1 text-xs font-medium bg-pink-500/20 text-pink-400 hover:bg-pink-500/30 hover:text-pink-300 rounded-lg transition-colors cursor-pointer"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => {
          setIsExiting(true);
          setTimeout(() => onDismiss(toast.id), 200);
        }}
        className="flex-shrink-0 text-[#57534e] hover:text-white transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="absolute bottom-4 left-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// Hook for managing toasts
export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (toast: Omit<ToastMessage, "id">) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...toast, id }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return { toasts, addToast, dismissToast };
}
