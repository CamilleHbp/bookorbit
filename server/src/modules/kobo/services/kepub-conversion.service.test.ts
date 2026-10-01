vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import { Test } from '@nestjs/testing';
import { storageConfig } from '../../../config/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { RevisionFileModule } from '../../book-revision/revision-file.module';
import { KepubConversionService } from './kepub-conversion.service';
import { KepubifyBinaryService } from './kepubify-binary.service';

async function epub(path: string, text: string) {
  const archive = new ZipArchive({ store: true });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const [name, content] of Object.entries({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
    'content.opf':
      '<package><metadata><title>Fixture</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'chapter.xhtml': `<html><body><p>${text}</p></body></html>`,
  }))
    archive.append(content, { name });
  await archive.finalize();
  await done;
  await writeFile(path, Buffer.concat(chunks));
}

describe('KepubConversionService', () => {
  let directory: string;
  let sourcePath: string;
  let service: KepubConversionService;
  let convert: (source: string, target: string) => Promise<void>;
  const binary = { getBinaryPath: vi.fn(), getVersion: vi.fn() };
  const execFileMock = vi.mocked(execFile);
  const input = () => ({ sourcePath, fileHash: 'same-partial-md5', bookId: 44, hyphenate: false });

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'bookorbit-kepub-cache-'));
    sourcePath = join(directory, 'source.epub');
    await epub(sourcePath, 'original passage');
    binary.getBinaryPath.mockResolvedValue('/tools/kepubify');
    binary.getVersion.mockResolvedValue('4.0.4');
    convert = copyFile;
    execFileMock.mockImplementation((_binary, args, _options, callback) => {
      const parameters = args as string[];
      const source = parameters.at(-1)!;
      const output = parameters[parameters.indexOf('--output') + 1]!;
      void convert(source, output).then(
        () => callback?.(null, '', ''),
        (error: Error) => callback?.(error, '', ''),
      );
      return {} as never;
    });
    const module = await Test.createTestingModule({
      imports: [RevisionFileModule],
      providers: [
        KepubConversionService,
        { provide: storageConfig.KEY, useValue: { appDataPath: directory } },
        { provide: KepubifyBinaryService, useValue: binary },
      ],
    }).compile();
    service = module.get(KepubConversionService);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('publishes a complete artifact and reuses it without rerunning conversion', async () => {
    const path = await service.getKepubPath(input());
    expect(path).toMatch(/\/44\/v2-[a-f0-9]{64}\.kepub\.epub$/);
    expect(await readFile(path)).toEqual(await readFile(sourcePath));
    expect(await service.getKepubPath(input())).toBe(path);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--output') + 1]).not.toBe(path);
    expect(execFileMock.mock.calls[0]![2]).toMatchObject({ timeout: 60_000, maxBuffer: 64 * 1024 });
    expect((await readdir(join(directory, '.kepub-cache/44'))).some((entry) => entry.startsWith('.conversion-'))).toBe(false);
  });

  it('separates files with colliding partial hashes, including missing hashes', async () => {
    const first = await service.getKepubPath(input());
    const other = join(directory, 'other.epub');
    await epub(other, 'different passage');
    const second = await service.getKepubPath({ ...input(), sourcePath: other });
    expect(second).not.toBe(first);
    expect(await readFile(second)).toEqual(await readFile(other));
    expect(await service.getKepubPath({ ...input(), sourcePath: other, fileHash: null })).toBe(second);
    await epub(sourcePath, 'edited again');
    expect(await service.getKepubPath({ ...input(), fileHash: null })).not.toBe(first);
  });

  it('separates converter versions and hyphenation settings', async () => {
    const first = await service.getKepubPath(input());
    const hyphenated = await service.getKepubPath({ ...input(), hyphenate: true });
    expect(hyphenated).not.toBe(first);
    expect(execFileMock.mock.calls[1]![1]).toContain('--hyphenate');
    binary.getVersion.mockResolvedValue('next');
    expect(await service.getKepubPath(input())).not.toBe(first);
  });

  it('does not publish partial output after a converter failure and permits retry', async () => {
    convert = async (_source, target) => {
      await writeFile(target, 'partial');
      throw new Error('conversion interrupted');
    };
    await expect(service.getKepubPath(input())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await readdir(join(directory, '.kepub-cache/44'))).toEqual([]);
    convert = copyFile;
    expect(await readFile(await service.getKepubPath(input()))).toEqual(await readFile(sourcePath));
  });

  it('rejects malformed successful output before it can enter the cache', async () => {
    convert = (_source, target) => writeFile(target, 'not an EPUB');
    await expect(service.getKepubPath(input())).rejects.toThrow();
    expect(await readdir(join(directory, '.kepub-cache/44'))).toEqual([]);
  });

  it('rejects a changed source before publication', async () => {
    convert = async (source, target) => {
      await copyFile(source, target);
      await epub(source, 'changed during conversion');
    };
    await expect(service.getKepubPath(input())).rejects.toBeInstanceOf(ConflictException);
    expect(await readdir(join(directory, '.kepub-cache/44'))).toEqual([]);
  });

  it('coalesces identical work and bounds concurrent conversion requests', async () => {
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    let count = 0;
    convert = async (source, target) => {
      if (++count === 2) bothStarted();
      await gate;
      await copyFile(source, target);
    };
    const first = service.getKepubPath(input());
    const duplicate = service.getKepubPath(input());
    const second = service.getKepubPath({ ...input(), hyphenate: true });
    try {
      await started;
      await expect(service.getKepubPath({ ...input(), bookId: 45 })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
    const paths = await Promise.all([first, duplicate, second]);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).not.toBe(paths[0]);
  });
});
