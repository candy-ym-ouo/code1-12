// IEEE 802.3 CRC-32（与 zlib/gzip 的 CRC32 相同），用于缓存文件完整性校验。
// 表在模块加载时构造一次，纯运行时零依赖。

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  #crc = 0xffffffff;

  update(data: Uint8Array): this {
    let crc = this.#crc;
    for (let i = 0; i < data.length; i += 1) {
      crc = TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    }
    this.#crc = crc;
    return this;
  }

  digest(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}
