export function clampContextMenuPosition(input: {
	x: number;
	y: number;
	width: number;
	height: number;
	viewportWidth: number;
	viewportHeight: number;
	inset?: number;
}): { left: number; top: number } {
	const inset = input.inset ?? 8;
	const maxLeft = Math.max(inset, input.viewportWidth - input.width - inset);
	const maxTop = Math.max(inset, input.viewportHeight - input.height - inset);
	return {
		left: Math.min(Math.max(inset, input.x), maxLeft),
		top: Math.min(Math.max(inset, input.y), maxTop)
	};
}
