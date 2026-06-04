/**
 * Toast Notification Store
 *
 * Simple toast system for showing success/error/info messages
 */

import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	type: ToastType;
	message: string;
	action?: {
		label: string;
		onClick: () => void;
	};
	duration?: number; // ms, 0 = persistent
}

function createToastStore() {
	const { subscribe, update } = writable<Toast[]>([]);

	let idCounter = 0;

	function add(toast: Omit<Toast, 'id'>): string {
		const id = `toast-${++idCounter}`;
		const newToast: Toast = { ...toast, id };

		update(toasts => [...toasts, newToast]);

		// Auto-remove after duration (default 5s, 0 = persistent).
		// Toasts that carry an `action` button stay until the user dismisses
		// or clicks the action — auto-hiding them would race the user's hand
		// to the button and the action would disappear before they could click.
		const explicitDuration = toast.duration;
		const duration = explicitDuration ?? (toast.action ? 0 : 5000);
		if (duration > 0) {
			setTimeout(() => remove(id), duration);
		}

		return id;
	}

	function remove(id: string) {
		update(toasts => toasts.filter(t => t.id !== id));
	}

	function clear() {
		update(() => []);
	}

	// Convenience methods
	function success(message: string, action?: Toast['action']) {
		return add({ type: 'success', message, action });
	}

	function error(message: string, action?: Toast['action']) {
		return add({ type: 'error', message, action, duration: 8000 }); // Errors stay longer
	}

	function warning(message: string, action?: Toast['action']) {
		return add({ type: 'warning', message, action });
	}

	function info(message: string, action?: Toast['action']) {
		return add({ type: 'info', message, action });
	}

	return {
		subscribe,
		add,
		remove,
		clear,
		success,
		error,
		warning,
		info
	};
}

export const toasts = createToastStore();
