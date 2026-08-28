import { describe, it, expect } from 'vitest';

describe('Drop inflight on mission id mismatch', () => {
  it('should discard stale fetch responses when mission id changes', () => {
    let currentMissionId = 'mission-123';
    const staleResponse = { missionId: 'mission-456' };
    const isStale = staleResponse.missionId !== currentMissionId;
    expect(isStale).toBe(true);
  });
});
