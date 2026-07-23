export function createQueuedPipelineId(): string {
	return `pipe-${crypto.randomUUID()}`;
}

export function createPrdRequestId(): string {
	return `prd-${crypto.randomUUID()}`;
}

export function createCanvasNodeId(): string {
	return `node-${crypto.randomUUID()}`;
}

export function createCanvasConnectionId(): string {
	return `conn-${crypto.randomUUID()}`;
}
