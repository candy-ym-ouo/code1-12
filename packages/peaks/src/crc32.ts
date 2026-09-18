/** CRC32（IEEE 802.3 多项式 0xEDB88320 反射形式），用于峰值文件完整性校验。 */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

/** 计算 data 全部内容（或给定区间）的 CRC32，返回无符号 32 位整数。 */
export function crc32(data: Uint8Array, start = 0, end: number = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
