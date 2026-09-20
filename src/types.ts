/** 一段待下载的字节区间，闭区间（end 为最后一个字节的下标）。 */
export interface Chunk {
  index: number;
  start: number;
  end: number;
}

/** 一个 GitHub 代理镜像。prefix 形如 "https://gh.xmly.dev/"，用法为 prefix + 原始 GitHub URL。 */
export interface Mirror {
  id: string;
  prefix: string;
}

/** 下载落盘目标。实现可以是 FSA，也可以是内存回退。 */
export interface Sink {
  /** 在文件顶部起 position 字节处写入 data。调用方会 await；写入按绝对 position 定位，与完成顺序无关。 */
  write(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface ProbeResult {
  mirror: Mirror;
  ok: boolean;
  bytesPerSec: number;
  ttfbMs: number;
}

/** 从 Release URL 解析出的坐标。 */
export interface ReleaseRef {
  owner: string;
  repo: string;
  tag: string;
  file: string;
}

/** 资源元数据。acceptRanges 为 false 时不得分块。 */
export interface AssetMeta {
  total: number;
  filename: string;
  acceptRanges: boolean;
}
