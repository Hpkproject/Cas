/**
 * Small browser-native ZIP reader used when the bundled JSZip reader cannot
 * handle a large archive. It reads only the central directory up front and
 * decompresses entries on demand, so a multi-gigabyte archive is not copied
 * into one in-memory buffer.
 */

const END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_END_RECORD = 22 + 0xffff;

export async function openZip(file) {
  const archive = new NativeZipArchive(file);
  await archive.open();
  return archive;
}

class NativeZipArchive {
  constructor(file) {
    this.sourceFile = file;
    this.files = Object.create(null);
  }

  async open() {
    const tailSize = Math.min(this.sourceFile.size, MAX_END_RECORD);
    const tail = new Uint8Array(await this.sourceFile.slice(this.sourceFile.size - tailSize).arrayBuffer());
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (readU32(tail, i) === END_SIGNATURE) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("Invalid ZIP: end-of-central-directory record not found.");

    let count = readU16(tail, end + 10);
    let centralSize = readU32(tail, end + 12);
    let centralOffset = readU32(tail, end + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locator = end - 20;
      if (locator < 0 || readU32(tail, locator) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new Error("Invalid ZIP64 archive: locator record is missing.");
      }
      const zip64Offset = readU64(tail, locator + 8);
      const zip64 = new Uint8Array(await this.sourceFile.slice(zip64Offset, zip64Offset + 56).arrayBuffer());
      if (readU32(zip64, 0) !== ZIP64_END_SIGNATURE) {
        throw new Error("Invalid ZIP64 archive: end record is malformed.");
      }
      count = readU64(zip64, 32);
      centralSize = readU64(zip64, 40);
      centralOffset = readU64(zip64, 48);
    }

    const central = new Uint8Array(
      await this.sourceFile.slice(centralOffset, centralOffset + centralSize).arrayBuffer()
    );
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (readU32(central, cursor) !== CENTRAL_SIGNATURE) {
        throw new Error("Invalid ZIP: central-directory entry is malformed.");
      }
      const flags = readU16(central, cursor + 8);
      const method = readU16(central, cursor + 10);
      const compressedSize = readU32(central, cursor + 20);
      const uncompressedSize = readU32(central, cursor + 24);
      const nameLength = readU16(central, cursor + 28);
      const extraLength = readU16(central, cursor + 30);
      const commentLength = readU16(central, cursor + 32);
      const localOffset = readU32(central, cursor + 42);
      const nameBytes = central.slice(cursor + 46, cursor + 46 + nameLength);
      const name = decodeName(nameBytes, flags);
      const extra = central.slice(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64Values = readZip64Extra(extra, {
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      this.files[name] = new ZipEntry(this.sourceFile, {
        name,
        dir: name.endsWith("/"),
        method,
        compressedSize: zip64Values.compressedSize,
        uncompressedSize: zip64Values.uncompressedSize,
        localOffset: zip64Values.localOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return this;
  }

  file(name) {
    return this.files[name] ?? null;
  }

  folder(prefix) {
    const normalized = String(prefix).replace(/\/?$/, "/");
    return Object.values(this.files).some((entry) => entry.name.startsWith(normalized));
  }

  filter(predicate) {
    return Object.values(this.files).filter((entry) => predicate(entry.name, entry));
  }
}

class ZipEntry {
  constructor(file, metadata) {
    Object.assign(this, metadata);
    this._file = file;
  }

  async async(type) {
    const bytes = await this.bytes();
    if (type === "uint8array") return bytes;
    if (type === "blob") return new Blob([bytes]);
    if (type === "string") return new TextDecoder().decode(bytes);
    throw new Error(`Unsupported ZIP entry output type: ${type}`);
  }

  async bytes() {
    const localHeader = new Uint8Array(
      await this._file.slice(this.localOffset, this.localOffset + 30).arrayBuffer()
    );
    if (readU32(localHeader, 0) !== LOCAL_SIGNATURE) {
      throw new Error(`Invalid ZIP: local header for "${this.name}" is malformed.`);
    }
    const nameLength = readU16(localHeader, 26);
    const extraLength = readU16(localHeader, 28);
    const start = this.localOffset + 30 + nameLength + extraLength;
    const compressed = this._file.slice(start, start + this.compressedSize);
    if (this.method === 0) return new Uint8Array(await compressed.arrayBuffer());
    if (this.method !== 8) {
      throw new Error(`Unsupported ZIP compression method ${this.method} for "${this.name}".`);
    }
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser does not support native ZIP deflate decompression.");
    }
    const stream = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readU64(bytes, offset) {
  const low = readU32(bytes, offset);
  const high = readU32(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) throw new Error("ZIP offset exceeds JavaScript's safe integer range.");
  return value;
}

function readZip64Extra(bytes, values) {
  if (
    values.uncompressedSize !== 0xffffffff &&
    values.compressedSize !== 0xffffffff &&
    values.localOffset !== 0xffffffff
  ) {
    return values;
  }
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const type = readU16(bytes, offset);
    const size = readU16(bytes, offset + 2);
    const end = offset + 4 + size;
    if (end > bytes.length) break;
    if (type === 0x0001) {
      let cursor = offset + 4;
      if (values.uncompressedSize === 0xffffffff) {
        values.uncompressedSize = readU64(bytes, cursor);
        cursor += 8;
      }
      if (values.compressedSize === 0xffffffff) {
        values.compressedSize = readU64(bytes, cursor);
        cursor += 8;
      }
      if (values.localOffset === 0xffffffff) values.localOffset = readU64(bytes, cursor);
      return values;
    }
    offset = end;
  }
  throw new Error("Invalid ZIP64 entry: size or offset extra field is missing.");
}

function decodeName(bytes, flags) {
  return new TextDecoder((flags & 0x800) !== 0 ? "utf-8" : "iso-8859-1").decode(bytes);
}
