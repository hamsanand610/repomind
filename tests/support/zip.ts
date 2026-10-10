/**
 * Builds ZIP archives for tests, including deliberately broken and hostile
 * ones (traversal names, symlinks, encryption flags, ZIP64 markers, size
 * lies, overlapping entries). Test-only; uses Node's zlib for deflate.
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../shared/zip/crc32.ts";

export interface ZipSpec {
  name: string;
  data?: string | Uint8Array;
  directory?: boolean;
  /** 0 stored, 8 deflate (default for files); any other value is written as-is with stored data. */
  method?: number;
  /** Extra general-purpose flag bits, e.g. 1 for "encrypted". */
  flags?: number;
  /** Unix mode (e.g. 0o120777 for a symlink); written with "made by Unix". */
  unixMode?: number;
  crc?: number;
  /** Uncompressed size written in the headers instead of the real one. */
  declaredSize?: number;
  /** Name bytes written instead of the UTF-8 name. */
  nameBytes?: Uint8Array;
  utf8Flag?: boolean;
}

export interface ZipOptions {
  comment?: string;
  /** Every directory record points at the first entry's data. */
  overlap?: boolean;
  /** Write 0xFFFF entries in the end record, as ZIP64 archives do. */
  zip64?: boolean;
  /** Bytes before the first local header (as in self-extracting archives). */
  prefix?: Uint8Array;
}

const encoder = new TextEncoder();

export function buildZip(specs: ZipSpec[], options: ZipOptions = {}): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = options.prefix?.length ?? 0;
  const firstOffset = offset;
  for (const spec of specs) {
    const data = typeof spec.data === "string" ? encoder.encode(spec.data) : (spec.data ?? new Uint8Array(0));
    const method = spec.method ?? (spec.directory ? 0 : 8);
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = spec.nameBytes ?? encoder.encode(spec.name);
    const flags = (spec.flags ?? 0) | (spec.utf8Flag ? 0x800 : 0);
    const crc = spec.crc ?? crc32(data);
    const size = spec.declaredSize ?? data.length;
    const madeBy = spec.unixMode !== undefined ? (3 << 8) | 20 : 20;
    const external = spec.unixMode !== undefined ? (spec.unixMode << 16) >>> 0 : spec.directory ? 0x10 : 0;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, flags, true);
    header.setUint16(8, method, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, stored.length, true);
    header.setUint32(22, size, true);
    header.setUint16(26, name.length, true);
    local.push(new Uint8Array(header.buffer), name, stored);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, madeBy, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, flags, true);
    record.setUint16(10, method, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, stored.length, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(38, external, true);
    record.setUint32(42, options.overlap ? firstOffset : offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + stored.length;
  }
  const directoryOffset = offset;
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const comment = encoder.encode(options.comment ?? "");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, options.zip64 ? 0xffff : specs.length, true);
  end.setUint16(10, options.zip64 ? 0xffff : specs.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, directoryOffset, true);
  end.setUint16(20, comment.length, true);
  return concat([options.prefix ?? new Uint8Array(0), ...local, ...central, new Uint8Array(end.buffer), comment]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const zipBlob = (bytes: Uint8Array) => new Blob([bytes]);
