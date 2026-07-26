import { describe, expect, it } from 'vitest';
import { BoundedProcessOutput } from './bounded-process-output';

describe('BoundedProcessOutput', () => {
	it('keeps output within the byte budget and records truncation once', () => {
		const output = new BoundedProcessOutput('OUTPUT', 5);
		output.append('abc');
		output.append('defgh');
		output.append('ignored');

		expect(output.toString()).toBe(
			'abcde\n[OUTPUT TRUNCATED: exceeded 5 byte buffer limit]'
		);
		expect(output.wasTruncated()).toBe(true);
	});

	it('does not split a multibyte character at the boundary', () => {
		const output = new BoundedProcessOutput('STDERR', 4);
		output.append('a🙂b');

		expect(output.toString()).toBe(
			'a\n[STDERR TRUNCATED: exceeded 4 byte buffer limit]'
		);
	});
});
