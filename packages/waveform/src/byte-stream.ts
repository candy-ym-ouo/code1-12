import type { Readable } from 'node:stream';

// 消费 Readable<Buffer> 的小块读取器：
// - 支持"精确读 N 字节"（读头/解析 fmt）和"尽量多拿"（帧泵）两种模式；
// - 维护积压字节数，超过水位时暂停上游、消费后恢复，形成背压；
// - 任意时刻只有一个等待中的读取请求（解析器串行调用，不允许并发读）。

export class ByteStream {
  #stream: Readable;
  #buffers: Buffer[] = [];
  #buffered = 0;
  #ended = false;
  #error: Error | null = null;
  #waiter: (() => void) | null = null;
  #highWaterMark: number;

  constructor(stream: Readable, highWaterMark = 8 * 1024 * 1024) {
    this.#stream = stream;
    this.#highWaterMark = highWaterMark;

    stream.on('data', (chunk: Buffer) => {
      this.#buffers.push(chunk);
      this.#buffered += chunk.length;
      if (this.#buffered >= this.#highWaterMark) stream.pause();
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = null;
        w();
      }
    });
    stream.on('end', () => {
      this.#ended = true;
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = null;
        w();
      }
    });
    stream.on('error', (error: Error) => {
      this.#error = error;
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = null;
        w();
      }
    });
  }

  #drainFront(consumed: number): void {
    let remaining = consumed;
    while (remaining > 0) {
      const head = this.#buffers[0]!;
      if (head.length <= remaining) {
        remaining -= head.length;
        this.#buffers.shift();
      } else {
        this.#buffers[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.#buffered -= consumed;
    if (this.#buffered < this.#highWaterMark && !this.#ended) {
      this.#stream.resume();
    }
  }

  /** 从内部缓冲拿走至多 maxBytes 字节（可能返回空 Buffer），不等待。 */
  takeMax(maxBytes: number): Buffer {
    if (this.#error) throw this.#error;
    if (maxBytes <= 0 || this.#buffered === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let taken = 0;
    while (taken < maxBytes && this.#buffers.length > 0) {
      const head = this.#buffers[0]!;
      if (head.length <= maxBytes - taken) {
        parts.push(head);
        taken += head.length;
        this.#buffers.shift();
      } else {
        const slice = head.subarray(0, maxBytes - taken);
        parts.push(slice);
        taken += slice.length;
        this.#buffers[0] = head.subarray(slice.length);
      }
    }
    this.#buffered -= taken;
    if (this.#buffered < this.#highWaterMark && !this.#ended) {
      this.#stream.resume();
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, taken);
  }

  async #waitForData(): Promise<void> {
    if (this.#buffered > 0 || this.#ended || this.#error) return;
    await new Promise<void>((resolve) => {
      this.#waiter = resolve;
    });
  }

  /** 精确读取 size 字节；流提前结束时返回 null。 */
  async readExact(size: number): Promise<Buffer | null> {
    if (size === 0) return Buffer.alloc(0);
    while (this.#buffered < size) {
      if (this.#error) throw this.#error;
      if (this.#ended) return null;
      await this.#waitForData();
    }
    const out = Buffer.allocUnsafe(size);
    let copied = 0;
    while (copied < size) {
      const head = this.#buffers[0]!;
      const n = Math.min(head.length, size - copied);
      head.copy(out, copied, 0, n);
      copied += n;
      if (n === head.length) this.#buffers.shift();
      else this.#buffers[0] = head.subarray(n);
    }
    this.#buffered -= size;
    if (this.#buffered < this.#highWaterMark && !this.#ended) {
      this.#stream.resume();
    }
    return out;
  }

  /** 跳过 size 字节；流提前结束返回 false。 */
  async skip(size: number): Promise<boolean> {
    let remaining = size;
    while (remaining > 0) {
      if (this.#error) throw this.#error;
      if (this.#buffered === 0) {
        if (this.#ended) return false;
        await this.#waitForData();
        continue;
      }
      const n = Math.min(remaining, this.#buffered);
      this.#drainFront(n);
      remaining -= n;
    }
    return true;
  }

  get buffered(): number {
    return this.#buffered;
  }

  get ended(): boolean {
    return this.#ended;
  }
}
