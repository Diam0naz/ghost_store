"use client";
// Confirmation dialog for actions that move money or change treasury state
// (approve → execution, pause). Same delayed fade/rise entrance as the other
// modals so it never pops in suddenly.

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Solid red confirm button instead of the brand purple. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary-950/40 p-4 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="card w-full max-w-sm p-6 animate-modal-in"
        style={{ animationDelay: "120ms" }}
      >
        <h2 className="text-lg font-semibold leading-tight text-primary-950">
          {title}
        </h2>
        <p className="mt-2 text-sm font-medium text-ink-600">{description}</p>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="btn-ghost flex-1 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={
              danger
                ? "flex-1 rounded-full bg-red-600 px-5 py-2 text-sm font-semibold text-white shadow-soft transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                : "btn-primary flex-1 disabled:opacity-40"
            }
          >
            {busy ? "Waiting for wallet…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
