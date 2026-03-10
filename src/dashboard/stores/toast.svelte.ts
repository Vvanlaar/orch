type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let toasts = $state<Toast[]>([]);
let nextId = 0;

// Confirm dialog state
let confirmState = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);

export function showToast(message: string, type: ToastType = 'info') {
  const id = nextId++;
  toasts = [...toasts, { id, message, type }];
  setTimeout(() => dismissToast(id), 5000);
}

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
}

export function getToasts() {
  return toasts;
}

export function showConfirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    confirmState = { message, resolve };
  });
}

export function getConfirmState() {
  return confirmState;
}

export function resolveConfirm(value: boolean) {
  confirmState?.resolve(value);
  confirmState = null;
}
