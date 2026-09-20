import { describe, it, expect, vi } from 'vitest';
import { supportsFsa, createFsaSink, UnsupportedBrowserError } from '../src/sink';

describe('supportsFsa', () => {
  it('showSaveFilePicker 与 createWritable 同时存在时为 true', () => {
    const stream = { createWritable: vi.fn() };
    expect(supportsFsa({ showSaveFilePicker: vi.fn(), FileSystemFileHandle: { prototype: stream } } as never)).toBe(true);
  });

  it('showSaveFilePicker 缺失时为 false', () => {
    expect(supportsFsa({} as never)).toBe(false);
  });

  it('仅有 showSaveFilePicker 而 createWritable 缺失时为 false（iOS Firefox 的情况）', () => {
    expect(supportsFsa({ showSaveFilePicker: vi.fn() } as never)).toBe(false);
  });
});

describe('createFsaSink', () => {
  it('不支持时抛 UnsupportedBrowserError', async () => {
    await expect(createFsaSink('a.bin', {} as never)).rejects.toBeInstanceOf(UnsupportedBrowserError);
  });

  it('调用 showSaveFilePicker 并传入 suggestedName', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    });
    const win = {
      showSaveFilePicker,
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;

    const sink = await createFsaSink('a.bin', win);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.bin' });

    await sink.write(100, new Uint8Array([1, 2, 3]));
    expect(write).toHaveBeenCalledWith({ type: 'write', position: 100, data: new Uint8Array([1, 2, 3]) });

    await sink.close();
    expect(close).toHaveBeenCalled();
  });

  it('createWritable 不得传 keepExistingData', async () => {
    const createWritable = vi.fn().mockResolvedValue({
      write: vi.fn(), close: vi.fn(), abort: vi.fn(),
    });
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({ createWritable }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    await createFsaSink('a.bin', win);
    expect(createWritable).toHaveBeenCalledWith();
  });
});
