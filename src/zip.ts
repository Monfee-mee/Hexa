/**
 * Reading a ZIP with no dependencies.
 *
 * It is needed for TWO things that look different and are the same: a folder
 * the client compressed, and a `.docx` —which is a ZIP with XML inside—. One
 * reader solves both.
 *
 * Node ships `zlib`, which is 90% of the work. What is missing is
 * understanding the file structure, and that is little: the central directory
 * at the end is read, not the local headers, because the central directory is
 * the reliable index —local headers can carry zero sizes and point to a
 * descriptor that comes AFTER the data—.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS IS SENT BY A STRANGER AND MUST BE TREATED AS SUCH.
 *
 * The ZIP comes from a client who paid, but paying does not make anyone
 * trustworthy. Three defences, and all three matter:
 *
 *   - A zip bomb: 42 kB that decompress into petabytes. The DECLARED size is
 *     checked before decompressing and a running total is kept, so it stops
 *     before allocating the memory, not after.
 *   - Paths with `..` or absolute ones: nothing is written to disk here, but
 *     the name travels to the model and ends up in logs. It is normalized
 *     anyway.
 *   - A ZIP with a hundred thousand empty entries, which does not inflate
 *     memory but does inflate time.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { inflateRawSync } from 'node:zlib';

/** A file inside the ZIP, already decompressed. */
export interface EntradaZip {
  /** The path inside the ZIP, already normalized. */
  nombre: string;
  bytes: Uint8Array;
}

export interface LimitesZip {
  /** Maximum number of entries looked at. */
  maxEntradas: number;
  /** Cap on the total decompressed size, all entries added up. */
  maxTotalBytes: number;
  /** Cap on a single entry. */
  maxEntradaBytes: number;
}

export const LIMITES_ZIP: LimitesZip = {
  maxEntradas: 200,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntradaBytes: 8 * 1024 * 1024,
};

/** The four bytes every ZIP starts with (and every .docx, .xlsx, .odt). */
export function esZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const u16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number): number =>
  (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/**
 * Strips whatever would do harm from an internal path.
 *
 * Nothing is written to disk, so this does not prevent a directory escape: it
 * prevents a made-up name —`../../etc/passwd`— from reaching the model and the
 * logs as if it were a real client file.
 */
function rutaLimpia(nombre: string): string {
  return nombre
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
    .slice(0, 200);
}

/** Where the central directory starts. Searched from the end. */
function buscarDirectorio(b: Uint8Array): number | null {
  // The trailing comment can take up to 64 kB, so looking at the last 22
  // bytes is not enough.
  const desde = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= desde; i--) {
    if (u32(b, i) === 0x06054b50) return u32(b, i + 16);
  }
  return null;
}

/**
 * The files of a ZIP, decompressed and capped.
 *
 * Folders and empty entries are skipped on their own: the content is what
 * matters. An entry that cannot be decompressed is SKIPPED instead of taking
 * down the whole read — a ZIP with one broken file still has ten good ones,
 * and the client already paid for whatever can be read to be read.
 */
export function leerZip(datos: Uint8Array, limites: LimitesZip = LIMITES_ZIP): EntradaZip[] {
  const inicio = buscarDirectorio(datos);
  if (inicio === null || inicio >= datos.length) return [];

  const salida: EntradaZip[] = [];
  let total = 0;
  let cursor = inicio;

  while (cursor + 46 <= datos.length && u32(datos, cursor) === 0x02014b50) {
    const metodo = u16(datos, cursor + 10);
    const comprimido = u32(datos, cursor + 20);
    const sinComprimir = u32(datos, cursor + 24);
    const nLargo = u16(datos, cursor + 28);
    const extraLargo = u16(datos, cursor + 30);
    const comentarioLargo = u16(datos, cursor + 32);
    const offsetLocal = u32(datos, cursor + 42);
    const nombre = rutaLimpia(new TextDecoder().decode(datos.subarray(cursor + 46, cursor + 46 + nLargo)));

    cursor += 46 + nLargo + extraLargo + comentarioLargo;

    if (salida.length >= limites.maxEntradas) break;
    // The size is checked BEFORE decompressing: it is the only thing standing
    // between this and allocating the petabytes the bomb asks for.
    if (!nombre || sinComprimir === 0) continue;
    if (sinComprimir > limites.maxEntradaBytes) continue;
    if (total + sinComprimir > limites.maxTotalBytes) break;

    // Now the local header does have to be read, only to know where the data
    // starts: its extra length can differ from the central directory's, and
    // assuming it is the same shifts the read.
    if (offsetLocal + 30 > datos.length || u32(datos, offsetLocal) !== 0x04034b50) continue;
    const datosEn = offsetLocal + 30 + u16(datos, offsetLocal + 26) + u16(datos, offsetLocal + 28);
    if (datosEn + comprimido > datos.length) continue;
    const crudo = datos.subarray(datosEn, datosEn + comprimido);

    try {
      const bytes = metodo === 0 ? crudo : metodo === 8 ? new Uint8Array(inflateRawSync(crudo)) : null;
      if (!bytes) continue;
      total += bytes.length;
      salida.push({ nombre, bytes });
    } catch {
      // Corrupt or encrypted entry: skip it and carry on with the rest.
      continue;
    }
  }

  return salida;
}

/* ══════════════════════════════════════════════════════════════════════════
 * WRITING
 *
 * Needed to return a `.docx`, which is a ZIP with XML inside. The same format
 * read above, the other way round.
 * ══════════════════════════════════════════════════════════════════════════ */

import { deflateRawSync } from 'node:zlib';

/** CRC-32, which ZIP requires per entry. Table built on the fly: 256 values. */
function crc32(bytes: Uint8Array): number {
  let c: number;
  const tabla: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = tabla[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escribirU16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function escribirU32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * Builds a ZIP.
 *
 * Everything is compressed with deflate. No real date —the MS-DOS epoch is
 * used and that is it— because a file whose bytes change every time it is
 * generated breaks a property that matters here: the delivery hash is anchored
 * on-chain, and generating the same thing twice must give exactly the same
 * bytes.
 */
export function escribirZip(entradas: { nombre: string; bytes: Uint8Array }[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = [...new TextEncoder().encode(e.nombre)];
    const comprimido = [...new Uint8Array(deflateRawSync(e.bytes))];
    const crc = crc32(e.bytes);

    const cabecera = [
      ...escribirU32(0x04034b50),
      ...escribirU16(20), // minimum version
      ...escribirU16(0),
      ...escribirU16(8), // deflate
      ...escribirU16(0), // time
      ...escribirU16(0x21), // date: 1980-01-01
      ...escribirU32(crc),
      ...escribirU32(comprimido.length),
      ...escribirU32(e.bytes.length),
      ...escribirU16(nombre.length),
      ...escribirU16(0),
      ...nombre,
    ];
    local.push(...cabecera, ...comprimido);

    central.push(
      ...escribirU32(0x02014b50),
      ...escribirU16(20), // version made by
      ...escribirU16(20),
      ...escribirU16(0),
      ...escribirU16(8),
      ...escribirU16(0),
      ...escribirU16(0x21),
      ...escribirU32(crc),
      ...escribirU32(comprimido.length),
      ...escribirU32(e.bytes.length),
      ...escribirU16(nombre.length),
      ...escribirU16(0),
      ...escribirU16(0), // comment
      ...escribirU16(0), // disk
      ...escribirU16(0), // internal attributes
      ...escribirU32(0), // external attributes
      ...escribirU32(offset),
      ...nombre,
    );
    offset += cabecera.length + comprimido.length;
  }

  const fin = [
    ...escribirU32(0x06054b50),
    ...escribirU16(0),
    ...escribirU16(0),
    ...escribirU16(entradas.length),
    ...escribirU16(entradas.length),
    ...escribirU32(central.length),
    ...escribirU32(local.length),
    ...escribirU16(0),
  ];

  return new Uint8Array([...local, ...central, ...fin]);
}
