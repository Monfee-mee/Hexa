/**
 * Handing the client back the file they asked for.
 *
 * An agent delivers TEXT: it is what the client is shown and what is anchored
 * on-chain. But many people do not want text in a box, they want a file to
 * open, forward or print. This turns one into the other.
 *
 * WHAT IS DELIVERED IS STILL THE TEXT. The file goes IN ADDITION, never
 * instead of it: its hash slips into the delivery and ends up on-chain, so the
 * client can prove the file they download is exactly the one delivered.
 * Replacing the text with the file would break that.
 *
 * AND NOTHING IS ATTACHED UNLESS ASKED FOR. Several of these agents are called
 * by another program that is going to read the answer; hanging a PDF nobody
 * will open on it is weight and confusion.
 */

import { llmChat, resolverLlm, stripFilesManifest } from '@panal/sdk';
import { textoAPdf } from './pdf.js';
import { escribirZip } from './zip.js';

export type Formato = 'pdf' | 'docx' | 'xlsx' | 'md' | 'txt' | 'csv' | 'json';

export interface ArchivoDeSalida {
  name: string;
  data: Uint8Array | string;
  mime?: string;
}

/**
 * Which format they asked for, if any.
 *
 * It looks at the BRIEF, not the answer: that is where the person says it.
 * And it searches in several languages, because the market is not only
 * Spanish-speaking — an English brief asking "as a Word document" has to come
 * out in Word.
 *
 * Returns `null` when nothing is asked for, which is the normal case.
 */
export function formatoPedido(brief: string): Formato | null {
  // The attachments manifest is NOT what the client asked for: it is protocol
  // bookkeeping, and it is appended at the END of the brief. Without removing
  // it, its `name:` and `mime:` lines are the last mentions of a format in the
  // text, and this function keeps precisely the last one.
  //
  // The effect is that the attachment picks the OUTPUT format. Seen on a real
  // mainnet job (#67): the client asked for JSON, attached a `.txt`, and the
  // manifest —`name: pedidos n.txt`, `mime: text/plain`— beat the "return only
  // the JSON" written earlier. A .txt was delivered.
  //
  // Not rare nor a lab case: almost every attachment carries in its name an
  // extension that is a format here. Attaching a PDF made the delivery a PDF,
  // whatever was asked for.
  const t = stripFilesManifest(brief).toLowerCase();
  const mencion: { formato: Formato; en: number }[] = [];

  for (const [formato, patron] of PATRONES) {
    for (const m of t.matchAll(patron)) mencion.push({ formato, en: m.index });
  }
  if (mencion.length === 0) return null;

  // The ones talking about the file that CAME IN do not count. Without this,
  // "read the attached PDF and give it back to me in Word" delivered a PDF:
  // the first format mentioned was the input's. It happened in an end-to-end
  // test, which is where it shows up, not in a made-up sentence.
  const deSalida = mencion.filter((x) => !esDeEntrada(t, x.en));
  if (deSalida.length === 0) return null;

  // If one is preceded by a delivery verb, that is the right one.
  const pedida = deSalida.find((x) => ENTREGA.test(t.slice(Math.max(0, x.en - 40), x.en)));
  if (pedida) return pedida.formato;

  // Otherwise the LAST one: the output format is usually stated at the end.
  return deSalida[deSalida.length - 1]!.formato;
}

/** How each format is named, in the market's languages. */
const PATRONES: [Formato, RegExp][] = [
  ['pdf', /\bpdfs?\b/g],
  ['docx', /\bdocx?\b|\bword\b/g],
  // "hoja de cálculo" and "spreadsheet" go to Excel, not CSV: whoever asks
  // like that wants to open it and add things up, not a text file with commas.
  ['xlsx', /\bxlsx?\b|\bexcel\b|hoja de c[aá]lculo|\bspreadsheet\b/g],
  ['csv', /\bcsvs?\b/g],
  ['json', /\bjson\b/g],
  ['md', /\bmarkdown\b|\bmd\b/g],
  ['txt', /\btxt\b|texto plano|plain text|archivo de texto|text file/g],
];

/** Being handed something: what tells asking for a format from naming it. */
const ENTREGA =
  /\b(devu[eé]lve|dame|d[aá]melo|entr[eé]ga|env[ií]a|quiero|genera|crea|exporta|conviert|p[aá]sa|as an?|in|into|return|output|format[oe]?|como)\b[^.]{0,30}$/;

/** And what gives away that it is about the file the client SENT. */
const ENTRADA = /\b(adjunt\w*|attach\w*|subid\w*|uploaded|este|esta|el|la|mi|my|the)\b/;

function esDeEntrada(t: string, en: number): boolean {
  const antes = t.slice(Math.max(0, en - 18), en);
  const despues = t.slice(en, en + 30);
  // "el PDF adjunto", "the attached pdf", "mi word": it is about what came in.
  return /\badjunt|attach|\bsub[ií]|uploaded|que te (mand|pas|envi)/.test(despues) || (ENTRADA.test(antes) && /\badjunt|attach/.test(despues));
}

/** Extension and type of each format. */
const TIPOS: Record<Formato, { ext: string; mime: string }> = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  docx: {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8' },
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  json: { ext: 'json', mime: 'application/json; charset=utf-8' },
};

/**
 * What XML does not accept as is.
 *
 * Control characters are removed on top of escaping: a single one makes Word
 * refuse to open the WHOLE file, without saying which one it was.
 */
function escaparXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not valid in XML, not even escaped.
    // eslint-disable-next-line no-control-regex -- they are exactly the ones to remove
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/**
 * A real `.docx`, with the minimum Word requires to open it.
 *
 * A .docx is a ZIP with three files inside. No library needed: each line of
 * the text is a `<w:p>` and that is it.
 */
export function textoADocx(titulo: string, texto: string): Uint8Array {
  const parrafo = (linea: string, negrita = false): string =>
    `<w:p><w:r>${negrita ? '<w:rPr><w:b/></w:rPr>' : ''}` +
    `<w:t xml:space="preserve">${escaparXml(linea)}</w:t></w:r></w:p>`;

  const cuerpo = [parrafo(titulo, true), ...texto.split(/\r?\n/).map((l) => parrafo(l))].join('');

  const documento =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${cuerpo}</w:body></w:document>`;

  const tipos =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const b = (s: string): Uint8Array => new TextEncoder().encode(s);
  return escribirZip([
    { nombre: '[Content_Types].xml', bytes: b(tipos) },
    { nombre: '_rels/.rels', bytes: b(rels) },
    { nombre: 'word/document.xml', bytes: b(documento) },
  ]);
}

/**
 * How a table is separated in text.
 *
 * Decided by looking at ALL lines and not the first: a table whose header has
 * a comma in a title —"Sales, by region"— would suggest the separator is the
 * comma when it really is the tab.
 */
function separadorDe(lineas: string[]): '\t' | ',' | null {
  const conTab = lineas.filter((l) => l.includes('\t')).length;
  if (conTab >= lineas.length / 2) return '\t';
  const conComa = lineas.filter((l) => l.includes(',')).length;
  if (conComa >= lineas.length / 2) return ',';
  return null;
}

/** A CSV can carry quoted fields with commas inside. */
function partirCsv(linea: string): string[] {
  const campos: string[] = [];
  let actual = '';
  let dentro = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]!;
    if (c === '"') {
      if (dentro && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else dentro = !dentro;
    } else if (c === ',' && !dentro) {
      campos.push(actual);
      actual = '';
    } else actual += c;
  }
  campos.push(actual);
  return campos;
}

/** `0` → A, `26` → AA. */
function letraDe(col: number): string {
  let s = '';
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * An `.xlsx` with the minimum Excel requires.
 *
 * Numbers are written AS NUMBERS and not as text. It is the difference
 * between a sheet you can add up and one where every cell carries the little
 * green triangle of "this looks like a number stored as text" — and adding up
 * is exactly what whoever asks for an Excel file is going to do.
 *
 * Strings go inline (`inlineStr`) instead of in a shared table: it takes a bit
 * more space and saves a whole part of the file, and size is not the problem
 * here.
 */
export function textoAXlsx(titulo: string, texto: string): Uint8Array {
  const lineas = texto.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const sep = separadorDe(lineas);
  const filas = lineas.map((l) => (sep === ',' ? partirCsv(l) : sep === '\t' ? l.split('\t') : [l]));

  const celdas = (fila: string[], nFila: number): string =>
    fila
      .map((valor, col) => {
        const ref = `${letraDe(col)}${nFila}`;
        if (valor === '') return '';
        // A number is a number; everything else, text.
        return /^-?\d+([.,]\d+)?$/.test(valor.trim())
          ? `<c r="${ref}"><v>${valor.trim().replace(',', '.')}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escaparXml(valor)}</t></is></c>`;
      })
      .join('');

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    filas.map((f, i) => `<row r="${i + 1}">${celdas(f, i + 1)}</row>`).join('') +
    '</sheetData></worksheet>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escaparXml(titulo).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  const tipos =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const b = (s: string): Uint8Array => new TextEncoder().encode(s);
  return escribirZip([
    { nombre: '[Content_Types].xml', bytes: b(tipos) },
    { nombre: '_rels/.rels', bytes: b(rels) },
    { nombre: 'xl/workbook.xml', bytes: b(workbook) },
    { nombre: 'xl/_rels/workbook.xml.rels', bytes: b(workbookRels) },
    { nombre: 'xl/worksheets/sheet1.xml', bytes: b(sheet) },
  ]);
}

/**
 * A table, if the delivered text carries one inside.
 *
 * Born from a real, bad result: an agent was asked for a spreadsheet, it
 * delivered its usual JSON —correct— and the Excel came out with ONE column
 * of sentences, because the text had neither commas nor tabs. Valid and
 * worthless: whoever asks for Excel wants columns to add up.
 *
 * So before building an xlsx or a csv it checks whether the delivery is JSON
 * with a list of flat objects. If it is, its keys are the header. If not, it
 * carries on as before.
 */
export function comoTabla(texto: string): string | null {
  let dato: unknown;
  try {
    dato = JSON.parse(texto);
  } catch {
    return null;
  }

  // The list can be the root, or sit inside under any name —agents call it
  // `hallazgos`, `entries`, `puertos`…
  const lista = Array.isArray(dato)
    ? dato
    : dato && typeof dato === 'object'
      ? Object.values(dato as Record<string, unknown>).find(
          (v): v is unknown[] => Array.isArray(v) && v.length > 0,
        )
      : undefined;
  if (!lista || lista.length === 0) return null;

  const filas = lista.filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
  );
  if (filas.length !== lista.length) return null;

  // The header is the union of the keys, in the order they appear: a row
  // missing a field must not shift the others.
  const columnas: string[] = [];
  for (const f of filas) for (const k of Object.keys(f)) if (!columnas.includes(k)) columnas.push(k);
  if (columnas.length === 0) return null;

  const celda = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    // A nested object does not fit in a cell; its JSON goes in rather than
    // "[object Object]", which helps nobody.
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).replace(/[\t\r\n]+/g, ' ');
  };

  return [
    columnas.map((c) => c.replace(/[_-]+/g, ' ')).join('\t'),
    ...filas.map((f) => columnas.map((c) => celda(f[c])).join('\t')),
  ].join('\n');
}

/* ── what the file is called ───────────────────────────────────────────── */

/**
 * Windows reserved characters and path separators.
 *
 * Letters are NOT touched: a name in Chinese, Arabic or with accents is a
 * perfectly valid name, and stripping them would be the exact opposite of
 * what is needed here.
 */
const PROHIBIDOS = /[/\\:*?"<>|]/g;

/** Maximum number of characters. A name is not a summary. */
const MAX_NOMBRE = 60;

/** Is it a printable character? Control characters are not valid in a name. */
function imprimible(c: string): boolean {
  const p = c.codePointAt(0) ?? 0;
  return p >= 0x20 && p !== 0x7f;
}

/**
 * Any title, turned into a file name.
 *
 * Exported so it can be tested without spending a model call.
 */
export function comoNombre(crudo: string): string {
  const linea = crudo.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const limpio = [...linea]
    .filter(imprimible)
    .join('')
    .trim()
    // The model returns the title in quotes more often than you would think.
    .replace(/^["'`«“]+|["'`»”]+$/g, '')
    // And sometimes adds an extension, which `comoArchivo` adds here.
    .replace(/\.(pdf|docx?|xlsx?|md|txt|csv|json|zip)$/i, '')
    .replace(PROHIBIDOS, ' ')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  // By code points and not with `.slice`: cutting by UTF-16 units splits a
  // character outside the basic plane in half.
  return [...limpio].slice(0, MAX_NOMBRE).join('').replace(/[-.]+$/, '');
}

/**
 * The `content-disposition` header for a downloaded file.
 *
 * TWO FORMS OF THE NAME, AND BOTH ARE NEEDED (RFC 6266). An HTTP header only
 * accepts latin-1, and since the file name is written by the model in the
 * client's language, a deliverable can be called `两个整数相除.pdf`.
 * Interpolating it as is into `filename="…"` does not just give an ugly name:
 * Node THROWS `ERR_INVALID_CHAR` when writing the header and the download
 * answers 500. The file was delivered, paid for and anchored on-chain, and
 * the client could not download it.
 *
 *   filename=   an ASCII version, for whoever does not understand the other
 *   filename*=  the real name, UTF-8 percent-encoded
 *
 * Browsers prefer `filename*` when present, so the good name is the one
 * shown. And quotes are dropped from the ASCII on purpose: a quote inside
 * `filename="…"` splits the header in half.
 */
export function comoAdjunto(nombre: string): string {
  const ascii =
    [...nombre]
      .map((c) => {
        const p = c.codePointAt(0) ?? 0;
        return p >= 0x20 && p < 0x7f && c !== '"' && c !== '\\' ? c : '_';
      })
      .join('')
      .replace(/_{2,}/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

/**
 * What the model is asked. Short on purpose: it is a name, not a summary.
 *
 * The two rules that really change the result are the last two. Without the
 * SUBJECT one, the model names the action —"write-test-cases"— and all files
 * from the same agent end up with the same name again, which is the problem
 * this is here to fix. And without the LANGUAGE one it answers in English even
 * when the brief comes in another language, because English is its default.
 */
const PIDE_UN_NOMBRE =
  'You name files. Given a client request, reply with ONLY a file name for the deliverable.\n' +
  'Two to five words. No extension, no quotes, no path, no explanation, no punctuation at the ends.\n' +
  'Name the SUBJECT the work is about, never the action asked for.\n' +
  // The previous example taught the opposite of what it asked: an ENGLISH
  // request got a Spanish answer ("division de dos enteros"), and job #95,
  // written in English, came out as "contactos-en-json". Now there is one
  // example per language, each answered in its own.
  'Write it in the language of the client\'s INSTRUCTIONS — what they ask for — not the language of ' +
  'the data they paste or of field names they spell out, and in their own script. No file-format ' +
  'words (JSON, PDF, CSV). Examples: "write the test cases for a function that divides two integers" ' +
  '-> "division of two integers"; "escribe los casos de prueba de una función que divide dos enteros" ' +
  '-> "division de dos enteros".\n' +
  // Saying it was not enough: with the data in Spanish and the instructions in
  // English, the model kept answering in Spanish. Forcing it to name the
  // instructions' language first is what fixes it (measured).
  'First decide the language of the instructions. Answer in exactly two lines:\n' +
  'LANG: <ISO code of the instructions\' language>\n' +
  'NAME: <the file name, in that language>';

/**
 * The name of the delivered file, taken from the SUBJECT of the brief.
 *
 * THEY ALL USED TO BE CALLED THE SAME. Each agent had a fixed name —
 * `casos-de-prueba.pdf`, `revision.pdf`, `traducciones.pdf`—, so a client who
 * ordered three things from the same agent ended up with three files of the
 * same name in their downloads folder, overwriting each other or showing up
 * as "casos-de-prueba (2).pdf". And it was in Spanish for everyone, when the
 * content had long been in the client's language.
 *
 * THE SUBJECT COMES FROM THE BRIEF, not the delivery. The delivery is plain
 * text with no title —the prompt forbids headings on purpose—, so its first
 * line is the first test case, not what the thing is about. The brief, on the
 * other hand, was written by the client: it states the subject and is in
 * their language.
 *
 * NEVER THROWS AND NEVER RETURNS EMPTY. If the model does not answer, is slow
 * or returns something useless, the usual name is used. Naming a file must
 * not stop it from being delivered: the payment is already locked.
 */
/**
 * From "LANG: en\nNAME: contact list", the name line.
 *
 * Without the label —a model not following the format— the whole answer is
 * kept, and `comoNombre` keeps its first line, as before.
 */
export function lineaDelNombre(crudo: string): string {
  const m = crudo.match(/^\s*NAME\s*:\s*(.+)$/im);
  return m ? m[1]! : crudo;
}

/**
 * THE LANGUAGE OF THE INSTRUCTIONS, without the data in front.
 *
 * Asking the model to "write in the client's language" does not work when the
 * brief carries data in another language: measured on 2026-09-28, with
 * instructions in English and a contact list in Spanish, the keys came out in
 * Spanish more than half the time, and a detector that saw the whole brief got
 * 19 out of 30 right (it took a French brief for Spanish, and a Chinese one
 * for English). The same detector with ONLY the first paragraph got 39 out of
 * 40.
 *
 * The first paragraph is what comes before the first blank line, which is how
 * a brief is almost always written: first what to do, then the data. If it is
 * too short to say anything, the first 300 characters are used.
 */
/**
 * The language name, in English, to tell the model.
 *
 * With only the code ("en") the model kept naming in Spanish an English brief
 * that quoted Spanish fields; with "Write the NAME in English" and the warning
 * that neither the data nor the quoted fields decide, it got 12 out of 12.
 */
const NOMBRES_DE_IDIOMA: Record<string, string> = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian',
  nl: 'Dutch', ca: 'Catalan', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi',
  bn: 'Bengali', ur: 'Urdu', ar: 'Arabic', fa: 'Persian', he: 'Hebrew', ru: 'Russian',
  uk: 'Ukrainian', pl: 'Polish', tr: 'Turkish', vi: 'Vietnamese', id: 'Indonesian', th: 'Thai',
  el: 'Greek', sv: 'Swedish',
};
export function nombreDeIdioma(codigo: string): string {
  return NOMBRES_DE_IDIOMA[codigo] ?? `the language with ISO code "${codigo}"`;
}

const PIDE_EL_IDIOMA =
  'You detect the language of a request. Reply with ONLY the ISO 639-1 code (two letters) of the ' +
  'language the text is written in. Ignore field names in quotes. Nothing else.';

export function parrafoDeInstrucciones(brief: string): string {
  const limpio = stripFilesManifest(brief).trim();
  const primero = limpio.split(/\n\s*\n/)[0]!.trim();
  return primero.length >= 12 ? primero : limpio.slice(0, 300);
}

/** ISO code of the language the instructions are written in, or null if it could not be told. */
export async function idiomaDeLasInstrucciones(brief: string): Promise<string | null> {
  try {
    const cfg = resolverLlm(process.env);
    const r = await llmChat(
      { ...cfg, timeoutMs: 15_000, maxRetries: 1 },
      { system: PIDE_EL_IDIOMA, user: parrafoDeInstrucciones(brief) },
    );
    const codigo = r.trim().toLowerCase().replace(/[^a-z]/g, '');
    return /^[a-z]{2}$/.test(codigo) ? codigo : null;
  } catch {
    return null;
  }
}

export async function nombreDelTema(brief: string, deReserva: string, idioma?: string | null): Promise<string> {
  // The language is decided from the instructions paragraph, not the whole
  // brief: see `idiomaDeLasInstrucciones`.
  idioma = idioma ?? (await idiomaDeLasInstrucciones(brief));
  try {
    const cfg = resolverLlm(process.env);
    const respuesta = await llmChat(
      // NEITHER THE TEMPERATURE NOR THE TOKEN CAP IS TOUCHED, and both lessons
      // were learned by testing against the real model.
      //
      // This used to set `temperature: 0` —the natural choice for something
      // deterministic— and the model rejected it with a 400: some models only
      // accept 1. And it set `maxTokens: 32` —it is a name, not a text— and the
      // answer came back with empty `choices`, because a model that reasons
      // before answering spends that budget thinking and has none left to
      // write.
      //
      // Both failures are INVISIBLE: it falls back to the usual name, which is
      // exactly what there was before, so the function would have been dead
      // without anyone noticing. It inherits what the operator already has
      // configured, which is what works in the rest of their calls.
      //
      // The only thing of its own is the clock: a timeout shorter than the
      // job's and a single retry, because this runs AFTER the delivery is
      // ready and must not delay it.
      { ...cfg, timeoutMs: 20_000, maxRetries: 1 },
      // The whole brief is not needed: the subject is at the start, and
      // sending it complete may mean sending a thirty-page contract to get
      // four words.
      // Without the manifest, for the same reason as in `formatoPedido`: the
      // budget is 1,500 characters and a 64-char hash takes room without
      // saying anything about the subject. With short attachments it could
      // slip in whole.
      {
        system: PIDE_UN_NOMBRE,
        // If the caller already knows the instructions' language, the model is
        // told: no need to guess it again, which is where the model gets it
        // wrong.
        user:
          stripFilesManifest(brief).trim().slice(0, 1_500) +
          (idioma
            ? `\n\n(Write the NAME in ${nombreDeIdioma(idioma)}, even if the data or the quoted field names ` +
              `are in another language. Answer LANG: ${idioma}.)`
            : ''),
      },
    );
    const nombre = comoNombre(lineaDelNombre(respuesta));
    if (nombre) return nombre;
    console.warn(`[output] the model gave no usable name; the file goes as "${deReserva}"`);
  } catch (err) {
    console.warn(
      `[output] could not name the file (${err instanceof Error ? err.message.split('\n')[0] : err}); ` +
        `it goes as "${deReserva}"`,
    );
  }
  return deReserva;
}

/**
 * The file ready to attach to the delivery.
 *
 * `paraLeer` is the human-readable version of the content, and it exists
 * because of a real case: some agents deliver JSON —good for a machine,
 * unreadable inside a PDF—, and there they are given separately what a person
 * should see. If not given, the text is used as is.
 */
export function comoArchivo(
  formato: Formato,
  nombreBase: string,
  titulo: string,
  texto: string,
  paraLeer?: string,
): ArchivoDeSalida {
  const { ext, mime } = TIPOS[formato];
  const name = `${nombreBase}.${ext}`;
  // For an Excel or CSV file, a TABLE inside the delivery is looked for first:
  // the prose version would give a single column of sentences, which is a
  // valid file and worthless to whoever asked for it to add things up.
  const tabla = formato === 'xlsx' || formato === 'csv' ? comoTabla(texto) : null;
  const legible = tabla ?? paraLeer ?? texto;

  switch (formato) {
    case 'pdf':
      return { name, data: textoAPdf(titulo, legible), mime };
    case 'docx':
      return { name, data: textoADocx(titulo, legible), mime };
    case 'xlsx':
      return { name, data: textoAXlsx(titulo, legible), mime };
    // Markdown carries the title as a heading, because that is what an `.md`
    // does. The rest go as is: a CSV with a `#` in front is no longer a CSV.
    case 'md':
      return { name, data: `# ${titulo}\n\n${legible}\n`, mime };
    case 'csv':
      // A tab-separated table is converted to commas; if there was no table,
      // the text goes as is, which is what it already did.
      return { name, data: tabla ? aCsv(tabla) : texto, mime };
    default:
      return { name, data: texto, mime };
  }
}

/** Tabs to commas, quoting only what needs it. */
function aCsv(tabla: string): string {
  return tabla
    .split('\n')
    .map((fila) =>
      fila
        .split('\t')
        .map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
        .join(','),
    )
    .join('\n');
}
