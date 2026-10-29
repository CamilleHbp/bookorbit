import { Readable, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CentralDirectory, File } from 'unzipper';
import { readConversionResource } from './conversion-archive';
import { readEpubSpine } from './epub-dom.service';

function entry(size: number, stream: Readable) {
  return { type: 'File', uncompressedSize: size, stream: vi.fn(() => stream) } as unknown as File;
}

describe('bounded conversion archive resources', () => {
  it('rejects package entity expansion before parsing', async () => {
    const xml = '<!DOCTYPE container [<!ENTITY expanded "unsafe">]><container>&expanded;</container>';
    const resource = { ...entry(Buffer.byteLength(xml), Readable.from([xml])), path: 'META-INF/container.xml' };
    await expect(readEpubSpine({ files: [resource] } as CentralDirectory)).rejects.toThrow('entity declarations');
  });

  it('reads a complete resource and closes its stream', async () => {
    const stream = Readable.from([Buffer.from('chapter')]);
    expect((await readConversionResource(entry(7, stream), 8)).toString()).toBe('chapter');
    expect(stream.destroyed).toBe(true);
  });

  it('rejects oversized declarations before starting decompression', async () => {
    const resource = entry(100, Readable.from([]));
    await expect(readConversionResource(resource, 10)).rejects.toThrow('size limit');
    expect(resource.stream).not.toHaveBeenCalled();
  });

  it.each([1, 8])('rejects inaccurate declared sizes %i and closes the stream', async (size) => {
    const stream = Readable.from([Buffer.from('data')]);
    await expect(readConversionResource(entry(size, stream), 10)).rejects.toThrow();
    expect(stream.destroyed).toBe(true);
  });

  it('limits simultaneous decompression and releases capacity after failure', async () => {
    const streams = Array.from({ length: 4 }, () => new PassThrough());
    const reads = streams.map((stream) => readConversionResource(entry(1, stream), 10).catch(() => null));
    await expect(readConversionResource(entry(1, Readable.from(['x'])), 10)).rejects.toThrow('busy');
    streams.forEach((stream) => stream.end());
    await Promise.all(reads);
    expect((await readConversionResource(entry(1, Readable.from(['x'])), 10)).toString()).toBe('x');
  });

  it('aborts stalled decompression and frees its slot', async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const check = expect(readConversionResource(entry(1, stream), 10)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5000);
      await check;
      expect(stream.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
