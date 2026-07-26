import { describe, expect, it, vi } from 'vitest';
import { dismissOnEscape } from './modal-keyboard';

describe('modal keyboard helpers', () => {
	it('dismisses and consumes Escape only', () => {
		const onDismiss = vi.fn();
		const ordinary = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
		const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });

		expect(dismissOnEscape(ordinary, onDismiss)).toBe(false);
		expect(ordinary.defaultPrevented).toBe(false);
		expect(dismissOnEscape(escape, onDismiss)).toBe(true);
		expect(escape.defaultPrevented).toBe(true);
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});
