import type { Sink } from './types';

export class UnsupportedBrowserError extends Error {
  constructor() {
    super('当前浏览器不支持 File System Access API（请使用 Chrome / Edge / Opera）');
    this.name = 'UnsupportedBrowserError';
  }
}

/**
 * 能力检测必须同时检查 createWritable——iOS 上的 Firefox 会暴露
 * showSaveFilePicker 却没有 createWritable。
 */
export function supportsFsa(win: unknown = globalThis): boolean {
  const w = win as Record<string, unknown>;
  if (typeof w.showSaveFilePicker !== 'function') return false;
  const proto = (w.FileSystemFileHandle as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return typeof proto?.createWritable === 'function';
}

/** 把 FSA 的流包成 Sink。不做任何缓冲——直接透传定位写入。 */
function wrap(stream: {
  write(d: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}): Sink {
  return {
    write: (position, data) => stream.write({ type: 'write', position, data }),
    close: () => stream.close(),
    abort: async () => {
      await (stream.abort?.() ?? stream.close());
    },
  };
}

export async function createFsaSink(suggestedName: string, win: unknown = globalThis): Promise<Sink> {
  if (!supportsFsa(win)) throw new UnsupportedBrowserError();
  const w = win as {
    showSaveFilePicker(o: { suggestedName: string }): Promise<{
      createWritable(): Promise<Parameters<typeof wrap>[0]>;
    }>;
  };
  const handle = await w.showSaveFilePicker({ suggestedName });
  // 刻意不传 keepExistingData：传 true 会先整份复制现有文件，对大文件是一次完整拷贝。
  const stream = await handle.createWritable();
  return wrap(stream);
}
