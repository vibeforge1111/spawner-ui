import { describe, expect, it } from 'vitest';
import { clampContextMenuPosition } from './context-menu-position';

describe('context menu viewport positioning', () => {
	it('keeps a menu inside narrow viewport edges', () => {
		expect(
			clampContextMenuPosition({
				x: 310,
				y: 190,
				width: 280,
				height: 170,
				viewportWidth: 320,
				viewportHeight: 200
			})
		).toEqual({ left: 32, top: 22 });
	});

	it('uses the inset when the menu is wider than the viewport', () => {
		expect(
			clampContextMenuPosition({
				x: 2,
				y: 2,
				width: 400,
				height: 300,
				viewportWidth: 320,
				viewportHeight: 200
			})
		).toEqual({ left: 8, top: 8 });
	});
});
