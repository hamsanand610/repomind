import { crc32 } from "./crc32.ts";
import { UPLOAD_LIMITS, type UploadLimits } from "./limits.ts";

/**
 * A minimal, defensive ZIP reader for the browser (and tests in Node). It
 * reads the central directory from slices of the file, never the whole
 * archive, and extracts one entry at a time with its size and CRC checked
 * while decompressing. Only "stored" and "deflate" entries can be extracted.
 * Nothing is written to a file system and nothing in the archive is run.
 */

export type ZipErrorReason =
  | "not_zip"
  | "too_large"
  | "empty"
  | "corrupt"
  | "encrypted"
  | "zip64"
  | "multi_disk"
  | "too_many_entries"
  | "zip_bomb"
  | "unsafe_path"
  | "duplicate_path"
  | "path_collision"
  | "too_many_files"
  | "no_files"
  | "timeout";

export class ZipError extends Error {
  readonly reason: ZipErrorReason;
  constructor(reason: ZipErrorReason, message: string) {
    super(message);
    this.name = "ZipError";
    this.reason = reason;
  }
}

export interface ZipEntry {
  /** Name as stored, with "\" converted to "/"; not yet validated. */
  name: string;
  /** False when the stored name bytes are not valid text in the declared encoding. */
  nameDecoded: boolean;
  nameBytes: Uint8Array;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Device, FIFO or socket entries (Unix archives). */
  isSpecial: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export interface ZipListing {
  archiveBytes: number;
  entries: ZipEntry[];
}

type Limits = UploadLimits;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const END_SIZE = 22;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const MAX_COMMENT = 0xffff;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const latin1 = new TextDecoder("latin1");
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function bytesOf(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Reads and checks the archive's central directory. No entry is decompressed. */
export async function readZipListing(blob: Blob, limits: Limits = UPLOAD_LIMITS, now: () => number = Date.now): Promise<ZipListing> {
  const deadline = now() + limits.scanTimeoutMs;
  const size = blob.size;
  if (size > limits.maxArchiveBytes) {
    throw new ZipError("too_large", `The archive is ${mb(size)}; the limit is ${mb(limits.maxArchiveBytes)}.`);
  }
  if (size < END_SIZE) throw new ZipError("not_zip", "This file is not a ZIP archive.");
  const head = new DataView((await bytesOf(blob, 0, 4)).buffer);
  const signature = head.getUint32(0, true);
  if (signature !== SIG_LOCAL && signature !== SIG_END) {
    throw new ZipError("not_zip", "This file is not a ZIP archive: its contents do not start with a ZIP signature.");
  }

  // The end record is the last 22 bytes plus a comment of up to 64 KB. It is
  // only accepted where its comment length reaches exactly the end of the file.
  const tailStart = Math.max(0, size - END_SIZE - MAX_COMMENT);
  const tail = await bytesOf(blob, tailStart, size);
  const tailView = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - END_SIZE; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_END && i + END_SIZE + tailView.getUint16(i + 20, true) === tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("corrupt", "The archive's file directory is missing. The file may be truncated or damaged.");
  if (end >= 20 && tailView.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) {
    throw new ZipError("zip64", "ZIP64 archives are not supported. Create a standard ZIP of the source files.");
  }
  const disk = tailView.getUint16(end + 4, true);
  const directoryDisk = tailView.getUint16(end + 6, true);
  const entriesOnDisk = tailView.getUint16(end + 8, true);
  const totalEntries = tailView.getUint16(end + 10, true);
  const directorySize = tailView.getUint32(end + 12, true);
  const directoryOffset = tailView.getUint32(end + 16, true);
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError("zip64", "ZIP64 archives are not supported. Create a standard ZIP of the source files.");
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError("multi_disk", "Split or multi-part ZIP archives are not supported.");
  }
  if (totalEntries === 0) throw new ZipError("empty", "The archive is empty.");
  if (totalEntries > limits.maxEntries) {
    throw new ZipError(
      "too_many_entries",
      `The archive has ${totalEntries.toLocaleString("en-US")} entries; the limit is ${limits.maxEntries.toLocaleString("en-US")}. Leave out dependency and build folders.`,
    );
  }
  const endOffset = tailStart + end;
  if (directoryOffset + directorySize > endOffset || directorySize < totalEntries * CENTRAL_SIZE) {
    throw new ZipError("corrupt", "The archive's file directory is inconsistent. The file may be damaged.");
  }
  if (directorySize > limits.maxCentralDirectoryBytes) {
    throw new ZipError("too_many_entries", "The archive's file directory is too large.");
  }

  const directory = await bytesOf(blob, directoryOffset, directoryOffset + directorySize);
  const view = new DataView(directory.buffer);
  const entries: ZipEntry[] = [];
  let pos = 0;
  let declaredTotal = 0;
  while (entries.length < totalEntries) {
    if (now() > deadline) throw new ZipError("timeout", "Reading the archive took too long.");
    if (pos + CENTRAL_SIZE > directory.length || view.getUint32(pos, true) !== SIG_CENTRAL) {
      throw new ZipError("corrupt", "The archive's file directory is damaged.");
    }
    const madeBy = view.getUint16(pos + 4, true);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const startDisk = view.getUint16(pos + 34, true);
    const externalAttributes = view.getUint32(pos + 38, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const next = pos + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new ZipError("corrupt", "The archive's file directory is damaged.");
    if (flags & 0x41) throw new ZipError("encrypted", "Password-protected (encrypted) archives are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError("zip64", "ZIP64 archives are not supported. Create a standard ZIP of the source files.");
    }
    if (startDisk !== 0) throw new ZipError("multi_disk", "Split or multi-part ZIP archives are not supported.");
    if (localHeaderOffset + LOCAL_SIZE + nameLength + compressedSize > directoryOffset) {
      throw new ZipError("corrupt", "An entry points outside the archive's data. The file may be damaged.");
    }

    const nameBytes = directory.slice(pos + CENTRAL_SIZE, pos + CENTRAL_SIZE + nameLength);
    const { text, decoded } = decodeName(nameBytes, (flags & 0x800) !== 0);
    const name = text.replaceAll("\\", "/");
    // Unix permission bits (archives made on Unix or macOS) mark symbolic links and special files.
    const host = madeBy >> 8;
    const type = host === 3 || host === 19 ? (externalAttributes >>> 16) & 0o170000 : 0;
    const isSymlink = type === 0o120000;
    entries.push({
      name,
      nameDecoded: decoded,
      nameBytes,
      isDirectory: name.endsWith("/"),
      isSymlink,
      isSpecial: type !== 0 && type !== 0o100000 && type !== 0o040000 && !isSymlink,
      method,
      crc32: crc,
      compressedSize,
      size: uncompressedSize,
      localHeaderOffset,
    });
    declaredTotal += uncompressedSize;
    pos = next;
  }
  if (pos !== directory.length) throw new ZipError("corrupt", "The archive's file directory is inconsistent. The file may be damaged.");

  // Entries must not share or overlap their data (a known ZIP-bomb technique).
  const byOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let i = 1; i < byOffset.length; i++) {
    const previous = byOffset[i - 1];
    if (previous.localHeaderOffset + LOCAL_SIZE + previous.nameBytes.length + previous.compressedSize > byOffset[i].localHeaderOffset) {
      throw new ZipError("zip_bomb", "Entries in this archive overlap each other. RepoMind rejects archives built this way.");
    }
  }
  if (declaredTotal > limits.maxDeclaredTotalBytes) {
    throw new ZipError("zip_bomb", `The archive would expand to ${mb(declaredTotal)}; the limit is ${mb(limits.maxDeclaredTotalBytes)}.`);
  }
  if (declaredTotal > limits.ratioMinBytes && declaredTotal / size > limits.maxArchiveRatio) {
    throw new ZipError("zip_bomb", "This archive expands far more than source code does, which is how ZIP bombs work. It was not opened.");
  }
  return { archiveBytes: size, entries };
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): { text: string; decoded: boolean } {
  if (!utf8Flag && bytes.every((byte) => byte < 0x80)) return { text: latin1.decode(bytes), decoded: true };
  try {
    return { text: utf8.decode(bytes), decoded: true };
  } catch {
    // Still checked for "../" and "/" so an undecodable name cannot hide a traversal.
    return { text: latin1.decode(bytes), decoded: false };
  }
}

/**
 * Extracts one entry. Its local header must agree with the directory, and the
 * output may not exceed the declared size: decompression stops the moment it
 * would, so a bomb never expands in memory. The CRC must match at the end.
 */
export async function readZipEntry(blob: Blob, entry: ZipEntry, maxBytes: number = UPLOAD_LIMITS.maxFileBytes): Promise<Uint8Array> {
  if (entry.size > maxBytes) throw new ZipError("too_large", `${entry.name} is larger than ${Math.round(maxBytes / 1024)} KB.`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("corrupt", `${entry.name} uses an unsupported compression method.`);
  const header = await bytesOf(blob, entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_SIZE);
  const view = new DataView(header.buffer);
  if (header.length < LOCAL_SIZE || view.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipError("corrupt", `The archive is damaged: ${entry.name} has no local header.`);
  }
  if (view.getUint16(6, true) & 0x41) throw new ZipError("encrypted", "Password-protected (encrypted) archives are not supported.");
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (view.getUint16(8, true) !== entry.method || nameLength !== entry.nameBytes.length) {
    throw new ZipError("corrupt", `The archive is damaged: the headers for ${entry.name} disagree.`);
  }
  const localName = await bytesOf(blob, entry.localHeaderOffset + LOCAL_SIZE, entry.localHeaderOffset + LOCAL_SIZE + nameLength);
  if (!localName.every((byte, i) => byte === entry.nameBytes[i])) {
    throw new ZipError("corrupt", `The archive is damaged: the headers for ${entry.name} disagree.`);
  }
  const dataStart = entry.localHeaderOffset + LOCAL_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > blob.size) throw new ZipError("corrupt", `The archive is truncated: ${entry.name} is incomplete.`);

  let output: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ZipError("corrupt", `The archive is damaged: the size of ${entry.name} is inconsistent.`);
    output = await bytesOf(blob, dataStart, dataEnd);
  } else {
    output = await inflateBounded(blob.slice(dataStart, dataEnd), entry);
  }
  if (output.length !== entry.size) throw new ZipError("corrupt", `The archive is damaged: ${entry.name} is shorter than declared.`);
  if (crc32(output) !== entry.crc32) throw new ZipError("corrupt", `The archive is damaged: the checksum of ${entry.name} does not match.`);
  return output;
}

async function inflateBounded(data: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const output = new Uint8Array(entry.size);
  let length = 0;
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > entry.size) {
        await reader.cancel().catch(() => {});
        throw new ZipError("zip_bomb", `${entry.name} expands beyond the size the archive declares for it. The archive was rejected.`);
      }
      output.set(value, length);
      length += value.length;
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt", `The archive is damaged: ${entry.name} could not be decompressed.`);
  }
  return output.subarray(0, length);
}
