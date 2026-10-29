import { describe, expect, it, vi } from 'vitest';
import { FanfictionRuntimeProgress } from './fanfiction-runtime-progress';

const line = (value: unknown) => Buffer.from(`BOOKORBIT_PROGRESS ${JSON.stringify(value)}\n`);
describe('runtime progress protocol', () => {
  it('handles split frames and strips private or unexpected fields', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const reader = new FanfictionRuntimeProgress(sink);
    const frame = line({ stage: 'downloading', completedChapters: 4, totalChapters: 10, url: 'private' });
    reader.feed(frame.subarray(0, 25));
    reader.feed(frame.subarray(25));
    await reader.flush();
    expect(sink).toHaveBeenCalledWith({ stage: 'downloading', completedChapters: 4, totalChapters: 10 });
  });
  it('ignores invalid counts, malformed data and diagnostics', async () => {
    const sink = vi.fn();
    const reader = new FanfictionRuntimeProgress(sink);
    reader.feed(Buffer.from('private diagnostic\nBOOKORBIT_PROGRESS broken\n'));
    for (const value of [
      null,
      { stage: 'other' },
      { stage: 'downloading', completedChapters: 11, totalChapters: 10 },
      { stage: 'downloading', completedChapters: -1, totalChapters: 10 },
      { stage: 'downloading', completedChapters: 1, totalChapters: 10001 },
    ])
      reader.feed(line(value));
    await reader.flush();
    expect(sink).not.toHaveBeenCalled();
  });
  it('keeps only the latest pending update while storage is busy', async () => {
    let release!: () => void;
    const sink = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const reader = new FanfictionRuntimeProgress(sink);
    for (let count = 0; count <= 100; count++) reader.feed(line({ stage: 'downloading', completedChapters: count, totalChapters: 100 }));
    expect(sink).toHaveBeenCalledTimes(1);
    release();
    await reader.flush();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith({ stage: 'downloading', completedChapters: 100, totalChapters: 100 });
  });
});
