/**
 * What the client attached, turned into something a model can use.
 *
 * A brief can bring five files of up to 25 MB, and they arrive verified: their
 * hash was announced INSIDE the brief before it was paid, so they are exactly
 * the ones the escrow covers. This file does the other half: opening them.
 *
 * Each type gets in however it can:
 *
 *   image (png/jpeg/gif/webp)  SHOWN to the model, not described
 *   text (code, md, csv…)      as is
 *   PDF                        its text is extracted
 *   .docx                      a ZIP with XML inside
 *   .zip                       opened, and whatever can be read is read
 *   anything else              NAMED, saying it could not be opened
 *
 * THAT LAST CASE IS NOT AN OVERSIGHT. Keeping quiet about a file that could
 * not be opened makes the model answer as if the client had sent nothing, and
 * the client gets an answer that ignores half of what they asked without
 * saying why. Saying so costs one line and turns a failure into an
 * explanation.
 *
 * THE TYPE IS JUDGED BY THE BYTES, not by the name or the `content-type` the
 * client sent: they write both, and a `.txt` that is really a PDF is a normal
 * accident, not an attack.
 */

import { esZip, leerZip } from './zip.js';

export interface AdjuntoRecibido {
  name: string;
  mime?: string;
  bytes: Uint8Array;
}

/** An image ready to show to the model. */
export interface ImagenAdjunta {
  mime: string;
  bytes: Uint8Array;
}

export interface AdjuntosLeidos {
  /** Already labelled and ready to append to the brief. Empty if there is nothing. */
  texto: string;
  /** The ones the model can actually look at. */
  imagenes: ImagenAdjunta[];
}

/** Character cap contributed by ONE attachment. The agent pays for the brief. */
export const MAX_CHARS_POR_ADJUNTO = 8_000;
/** And for all of them together, because five files at the cap are too much. */
export const MAX_CHARS_TOTAL = 24_000;

/**
 * How much text is let in, if the paid tier allows more.
 *
 * The caps above are the usual ones and remain the default. An agent selling a
 * "summarize this book" tier needs to raise them for that job and only that
 * one: cutting a book down to 8,000 characters and charging the same is
 * exactly what must not happen.
 */
export interface TopesTexto {
  porAdjunto?: number;
  total?: number;
}
/** Files looked at inside a ZIP. */
const MAX_DENTRO_DEL_ZIP = 40;

const MIMES_IMAGEN: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** What this is, judging by the first bytes. */
export function tipoDe(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'otro' {
  const b = bytes;
  if (b.length < 4) return 'otro';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  // %PDF- may come after a few junk bytes; the standard tolerates up to 1024,
  // and some generators take advantage of that.
  const cabeza = new TextDecoder('latin1').decode(b.subarray(0, Math.min(1024, b.length)));
  if (cabeza.includes('%PDF-')) return 'pdf';
  if (esZip(b)) return 'zip';
  return 'otro';
}

/**
 * Is this text?
 *
 * Decoded in strict mode, so a binary THROWS instead of slipping through as a
 * trail of replacement characters. And even when it decodes fine, anything
 * carrying control bytes is rejected: some binaries pass as valid UTF-8, and
 * sending them to a model spends the job on garbage.
 */
export function comoTexto(bytes: Uint8Array): string | null {
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const ch of texto) {
      const c = ch.codePointAt(0)!;
      if (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return null;
    }
    return texto;
  } catch {
    return null;
  }
}

/**
 * The text of a `.docx`.
 *
 * A .docx is a ZIP with `word/document.xml` inside. No need to understand
 * Word: every `</w:p>` closes a paragraph and every `<w:t>` wraps a piece of
 * text. Strip the tags and the words remain.
 *
 * The `<w:t>` pieces are kept GLUED together on purpose: Word splits one
 * sentence into several when something in the formatting changes, and putting
 * spaces between them would write "contr actor" where it says "contractor".
 */
export function textoDeDocx(bytes: Uint8Array): string | null {
  const doc = leerZip(bytes).find((e) => e.nombre === 'word/document.xml');
  if (!doc) return null;
  const xml = comoTexto(doc.bytes);
  if (!xml) return null;
  return xml
    .replace(/<w:p\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `A1` → 0, `B1` → 1, `AA7` → 26. Keeps a row with gaps from shifting. */
function columnaDe(ref: string): number {
  const letras = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1];
  if (!letras) return 0;
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** What the XML carries escaped, back to text. */
function desescapar(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * The content of an `.xlsx`, as rows of text.
 *
 * An Excel file is another ZIP with XML, like a .docx, with a twist: text
 * cells usually do not store the text. They store an INDEX into
 * `sharedStrings.xml`, where each string appears only once even if it repeats
 * in a thousand cells. Without resolving that table, a sheet full of names
 * reads as a list of numbers.
 *
 * And there are four ways for a cell to hold text, depending on who wrote the
 * file: `t="s"` (the table), `t="str"` (a formula result), `t="inlineStr"`
 * (the text right there) and no `t` (a number). All four are handled because
 * Excel, LibreOffice and the libraries do not pick the same one.
 *
 * Rows come out tab-separated: that is what a model reads as a table without
 * guessing where a cell ends, and it needs no quoting.
 */
export function textoDeXlsx(bytes: Uint8Array): string | null {
  const partes = leerZip(bytes);
  const hojas = partes
    .filter((e) => /^xl\/worksheets\/sheet\d*\.xml$/.test(e.nombre))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (hojas.length === 0) return null;

  // The shared strings table, if there is one.
  const compartidas: string[] = [];
  const tabla = partes.find((e) => e.nombre === 'xl/sharedStrings.xml');
  if (tabla) {
    const xml = comoTexto(tabla.bytes) ?? '';
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      // A string may be split across several <t> when it carries formatting
      // inside; they are glued with no separator, as in Word.
      compartidas.push(desescapar([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '').join('')));
    }
  }

  const salida: string[] = [];
  for (const hoja of hojas) {
    const xml = comoTexto(hoja.bytes);
    if (!xml) continue;
    const filas: string[] = [];

    for (const fila of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const celdas: string[] = [];
      for (const m of fila.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = m[1] ?? '';
        const cuerpo = m[2] ?? '';
        const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '';

        let valor = '';
        if (tipo === 'inlineStr') {
          valor = desescapar([...cuerpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1] ?? '').join(''));
        } else {
          const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1] ?? '';
          if (tipo === 's') valor = compartidas[Number(v)] ?? '';
          else if (tipo === 'b') valor = v === '1' ? 'TRUE' : 'FALSE';
          else valor = desescapar(v);
        }

        // A row can skip columns: `A1` and then `D1`. Putting each value in
        // ITS column is what keeps a table with gaps from shifting, with the
        // model reading a value under another header.
        const col = ref ? columnaDe(ref) : celdas.length;
        while (celdas.length < col) celdas.push('');
        celdas[col] = valor;
      }
      if (celdas.some((c) => c !== '')) filas.push(celdas.join('\t'));
    }

    if (filas.length > 0) {
      salida.push(hojas.length > 1 ? `[sheet ${salida.length + 1}]\n${filas.join('\n')}` : filas.join('\n'));
    }
  }

  return salida.length > 0 ? salida.join('\n\n') : null;
}

/**
 * The text of a PDF.
 *
 * Relies on `unpdf`, which is the pdf.js engine packaged. This was decided
 * after measuring: a hand-written extractor reads the PDFs this very agent
 * generates fine and chokes on the ones from Word or Chrome, which are exactly
 * what a client sends. Font encodings are the problem, and solving them is
 * what pdf.js does.
 *
 * Returns null if no text comes out: a scanned PDF is an image inside a PDF,
 * and without OCR there is nothing to read. Saying so beats delivering
 * nothing.
 */
export async function textoDePdf(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(bytes);
    const { text } = await extractText(doc, { mergePages: true });
    const limpio = (Array.isArray(text) ? text.join('\n') : text).trim();
    return limpio.length > 0 ? limpio : null;
  } catch {
    return null;
  }
}

/** Trims and says it trimmed, which is what prevents a half quote. */
function acotar(texto: string, tope: number): string {
  if (texto.length <= tope) return texto;
  return `${texto.slice(0, tope)}\n--- (trimmed: ${texto.length} characters in total) ---`;
}

/**
 * Opens every attachment of a brief.
 *
 * It is `async` because reading a PDF is. Agents already worked in `async`,
 * so the only change for the caller is an `await`.
 */
export async function leerAdjuntos(
  adjuntos: AdjuntoRecibido[],
  topes: TopesTexto = {},
): Promise<AdjuntosLeidos> {
  const partes: string[] = [];
  const imagenes: ImagenAdjunta[] = [];
  let gastado = 0;

  // Never below the usual cap: a badly declared tier can raise this, not
  // lower it by surprise for whoever was counting on the long-standing 8,000.
  const porAdjunto = Math.max(topes.porAdjunto ?? 0, MAX_CHARS_POR_ADJUNTO);
  const total = Math.max(topes.total ?? 0, MAX_CHARS_TOTAL);

  const anadir = (cabecera: string, cuerpo: string): void => {
    const queda = total - gastado;
    if (queda <= 200) return;
    const trozo = acotar(cuerpo, Math.min(porAdjunto, queda));
    gastado += trozo.length;
    partes.push(`--- ${cabecera} ---\n${trozo}\n--- end ---`);
  };

  const noSePudo = (a: AdjuntoRecibido, motivo: string): void => {
    partes.push(
      `[Attached file "${a.name}"${a.mime ? ` (${a.mime})` : ''}: ${motivo}. ` +
        `Say so clearly in the answer instead of ignoring it.]`,
    );
  };

  for (const a of adjuntos) {
    const tipo = tipoDe(a.bytes);

    if (tipo in MIMES_IMAGEN) {
      // The image is not described: it is shown. The agent decides whether its
      // model can look at it; here it is only separated from the text.
      imagenes.push({ mime: MIMES_IMAGEN[tipo]!, bytes: a.bytes });
      partes.push(`[Attached image "${a.name}": it comes with this message, look at it.]`);
      continue;
    }

    if (tipo === 'pdf') {
      const texto = await textoDePdf(a.bytes);
      if (texto) anadir(`Attached PDF: ${a.name}`, texto);
      else noSePudo(a, 'it is a PDF no text could be extracted from (probably scanned)');
      continue;
    }

    if (tipo === 'zip') {
      // Word and Excel files are ZIPs too, so they are tried before treating it
      // as a folder: reading an .xlsx entry by entry would return its raw XML,
      // which for a model is expensive noise.
      const docx = textoDeDocx(a.bytes);
      if (docx) {
        anadir(`Attached document: ${a.name}`, docx);
        continue;
      }
      const xlsx = textoDeXlsx(a.bytes);
      if (xlsx) {
        anadir(`Attached spreadsheet (tab-separated columns): ${a.name}`, xlsx);
        continue;
      }
      // A plain ZIP: a folder. The ones that are text are read and the rest
      // are NAMED, so the model knows what was inside.
      const dentro = leerZip(a.bytes).slice(0, MAX_DENTRO_DEL_ZIP);
      if (dentro.length === 0) {
        noSePudo(a, 'it is a compressed file that could not be opened');
        continue;
      }
      const ilegibles: string[] = [];
      for (const e of dentro) {
        const texto = comoTexto(e.bytes);
        if (texto === null) ilegibles.push(e.nombre);
        else anadir(`${a.name} → ${e.nombre}`, texto);
      }
      if (ilegibles.length > 0) {
        partes.push(`[Inside "${a.name}" there are ${ilegibles.length} non-text file(s): ${ilegibles.join(', ')}.]`);
      }
      continue;
    }

    const texto = comoTexto(a.bytes);
    if (texto !== null) anadir(`Attached file: ${a.name}`, texto);
    else noSePudo(a, 'it is not text and this agent cannot open it');
  }

  return { texto: partes.join('\n\n'), imagenes };
}

/**
 * The image in the format `/chat/completions` expects.
 *
 * It lives here and not in each agent because all four need it the same way,
 * and a badly built data URL fails with a provider error that says nothing.
 */
export function parteDeImagen(img: ImagenAdjunta): {
  type: 'image_url';
  image_url: { url: string };
} {
  return {
    type: 'image_url',
    image_url: { url: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}` },
  };
}
