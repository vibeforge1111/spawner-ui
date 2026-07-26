export function dismissOnEscape(event: KeyboardEvent, onDismiss: () => void): boolean {
	if (event.key !== 'Escape') return false;
	event.preventDefault();
	onDismiss();
	return true;
}
