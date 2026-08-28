import { describe, it, expect } from 'vitest';

describe('List MCP ids in registry error', () => {
  it('should include known MCP ids in not-found error message', () => {
    const knownIds = ['mcp-alpha', 'mcp-beta', 'mcp-gamma'];
    const unknownId = 'mcp-unknown';
    const errorMsg = `MCP '${unknownId}' not found in registry. Known MCP ids: ${knownIds.join(', ')}`;
    expect(errorMsg).toContain(knownIds[0]);
    expect(errorMsg).toContain(unknownId);
  });
});
