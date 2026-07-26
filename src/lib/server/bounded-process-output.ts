export const PROCESS_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export class BoundedProcessOutput {
	private readonly parts: string[] = [];
	private bytes = 0;
	private truncated = false;

	constructor(
		private readonly streamLabel: 'OUTPUT' | 'STDERR',
		private readonly limitBytes = PROCESS_OUTPUT_LIMIT_BYTES
	) {}

	append(chunk: string): void {
		if (this.truncated || chunk.length === 0) return;

		const remainingBytes = Math.max(0, this.limitBytes - this.bytes);
		const chunkBytes = Buffer.byteLength(chunk, 'utf8');
		if (chunkBytes <= remainingBytes) {
			this.parts.push(chunk);
			this.bytes += chunkBytes;
			return;
		}

		const accepted: string[] = [];
		let acceptedBytes = 0;
		for (const character of chunk) {
			const characterBytes = Buffer.byteLength(character, 'utf8');
			if (acceptedBytes + characterBytes > remainingBytes) break;
			accepted.push(character);
			acceptedBytes += characterBytes;
		}
		if (accepted.length > 0) this.parts.push(accepted.join(''));
		this.bytes += acceptedBytes;
		this.parts.push(
			`\n[${this.streamLabel} TRUNCATED: exceeded ${this.limitBytes} byte buffer limit]`
		);
		this.truncated = true;
	}

	toString(): string {
		return this.parts.join('');
	}

	wasTruncated(): boolean {
		return this.truncated;
	}
}
