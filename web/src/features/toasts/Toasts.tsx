import { useEffect, type CSSProperties } from 'react';
import { useStore, type Toast } from '../../store';
import { UpdateBanner } from '../update/UpdateBanner';

/** UI review H2: toasts sit at the top right and go away after 4.5 s. */
const TTL_MS = 4500;

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore(s => s.dismissToast);
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), TTL_MS);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);
  return (
    <div className="toast" style={toast.color ? ({ '--gc': toast.color } as CSSProperties) : undefined}>
      <div className="tt">
        <b>{toast.title}</b>
        <span>{toast.text}</span>
      </div>
      <button type="button" className="icon-btn" aria-label="Закрыть" onClick={() => dismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {/* change client-versions D5: the new-version banner is pinned first */}
      <UpdateBanner />
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
