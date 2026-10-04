/**
 * A real PDF, with no dependencies. You can delete this file if your agent
 * does not deliver PDFs.
 *
 * It is not a template or printed HTML: the PDF objects are written by hand,
 * with their xref table and byte offsets. The result opens in any reader and
 * adds not a single package to your dependencies — pulling in a 4 MB library
 * to draw monospaced text on an A4 page is not worth it.
 *
 * Used from `agent.ts`:
 *
 *     const pdf = textoAPdf('My report', text);
 *     return { text, files: [{ name: 'report.pdf', data: pdf, mime: 'application/pdf' }] };
 *
 * The engine computes its hash and anchors it on-chain; you touch none of that.
 *
 * What it gets right that is hard to get right by hand: it wraps long lines so
 * they do not run off the page, paginates on its own, and translates the
 * symbols the PDF encoding lacks instead of silently mangling them.
 */

/** A4 in points, the PDF unit. */
const ANCHO = 595;
const ALTO = 842;
const MARGEN = 50;
const CUERPO = 9.5;
const INTERLINEA = 12.5;
/** How many lines fit on a page with these margins. */
const LINEAS_POR_PAGINA = Math.floor((ALTO - MARGEN * 2) / INTERLINEA);
/** Character width at 9.5pt in Courier: 0.6 em, rounded down. */
const COLUMNAS = Math.floor((ANCHO - MARGEN * 2) / (CUERPO * 0.6));

/**
 * Escapes a text to put it between parentheses in a PDF.
 *
 * Parentheses delimit strings, so an unescaped one breaks the whole file — and
 * a JSON is full of them.
 */
function escapar(texto: string): string {
  return texto.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Wraps long lines so they do not run off the page.
 *
 * A PDF does not wrap text by itself: whatever does not fit is simply not
 * shown. With a single-line JSON that means delivering an almost blank page.
 */
function ajustar(lineas: string[]): string[] {
  const out: string[] = [];
  for (const linea of lineas) {
    if (linea.length <= COLUMNAS) {
      out.push(linea);
      continue;
    }
    // Indentation is kept when wrapping: in a JSON it is what shows the
    // structure, and without it the break makes it unreadable.
    const sangria = /^\s*/.exec(linea)![0].slice(0, 20);
    let resto = linea;
    let primera = true;
    while (resto.length > 0) {
      const ancho = primera ? COLUMNAS : COLUMNAS - sangria.length;
      out.push((primera ? '' : sangria) + resto.slice(0, ancho));
      resto = resto.slice(ancho);
      primera = false;
    }
  }
  return out;
}

/**
 * ASCII stand-ins for the symbols WinAnsiEncoding lacks.
 *
 * Without this, `Buffer.from(txt, 'latin1')` truncates them to the low byte
 * and out come meaningless characters: a "≠" ended up printed as "`", so a
 * test case reading "b ≠ 0" turned into "b ` 0". Silent, and inside a paid
 * deliverable.
 */
const SUSTITUTOS: Record<string, string> = {
  '≠': '!=', '≤': '<=', '≥': '>=', '≈': '~=', '±': '+/-', '×': 'x', '÷': '/',
  '→': '->', '←': '<-', '⇒': '=>', '∞': 'infinity', '∅': 'empty',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '‹': '<', '›': '>',
  '–': '-', '—': '-', '…': '...', '•': '-', '·': '·', '™': '(TM)', '€': 'EUR',
};

/**
 * Latin-1, which is what WinAnsiEncoding —the encoding of the PDF base
 * fonts— understands, replacing first whatever does not fit.
 *
 * Anything with no stand-in is marked with "?" on purpose: a question mark
 * warns that something was missing there; a random character lies.
 */
function aLatin1(texto: string): Buffer {
  const convertido = [...texto]
    .map((c) => {
      if (SUSTITUTOS[c]) return SUSTITUTOS[c];
      return c.codePointAt(0)! <= 0xff ? c : '?';
    })
    .join('');
  return Buffer.from(convertido, 'latin1');
}

/** Builds the PDF. Returns the bytes, ready to write or deliver. */
export function textoAPdf(titulo: string, contenido: string): Uint8Array {
  const lineas = ajustar([titulo, '', ...contenido.split('\n')]);

  // Split into pages before writing anything: we need to know how many there
  // are to number the objects, and PDF objects are referenced by number.
  const paginas: string[][] = [];
  for (let i = 0; i < lineas.length; i += LINEAS_POR_PAGINA) {
    paginas.push(lineas.slice(i, i + LINEAS_POR_PAGINA));
  }
  if (paginas.length === 0) paginas.push(['(no content)']);

  // Numbering: 1 catalog, 2 page tree, 3 font, then each page with its
  // content stream, two objects per page.
  const FUENTE = 3;
  const primeraPagina = 4;
  const idPagina = (i: number) => primeraPagina + i * 2;
  const idContenido = (i: number) => primeraPagina + i * 2 + 1;

  const objetos: Buffer[] = [];
  const add = (n: number, cuerpo: string | Buffer) => {
    objetos[n] = Buffer.concat([
      aLatin1(`${n} 0 obj\n`),
      typeof cuerpo === 'string' ? aLatin1(cuerpo) : cuerpo,
      aLatin1('\nendobj\n'),
    ]);
  };

  const kids = paginas.map((_, i) => `${idPagina(i)} 0 R`).join(' ');
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>`);
  add(FUENTE, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  paginas.forEach((lineasPagina, i) => {
    add(
      idPagina(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] ` +
        `/Resources << /Font << /F1 ${FUENTE} 0 R >> >> /Contents ${idContenido(i)} 0 R >>`,
    );

    const flujo = aLatin1(
      [
        'BT',
        `/F1 ${CUERPO} Tf`,
        `${INTERLINEA} TL`,
        `${MARGEN} ${ALTO - MARGEN} Td`,
        ...lineasPagina.map((l) => `(${escapar(l)}) Tj T*`),
        'ET',
      ].join('\n'),
    );
    // /Length is in BYTES, not characters: with accents they differ, and a
    // strict reader rejects the file if it does not match.
    add(idContenido(i), Buffer.concat([aLatin1(`<< /Length ${flujo.length} >>\nstream\n`), flujo, aLatin1('\nendstream')]));
  });

  // Assembly: the byte offset of each object has to be recorded, because the
  // xref table at the end indexes them by absolute position in the file.
  const total = objetos.length - 1;
  const partes: Buffer[] = [aLatin1('%PDF-1.4\n')];
  const offsets: number[] = [];
  let cursor = partes[0]!.length;

  for (let n = 1; n <= total; n++) {
    offsets[n] = cursor;
    partes.push(objetos[n]!);
    cursor += objetos[n]!.length;
  }

  const xref = [
    'xref',
    `0 ${total + 1}`,
    '0000000000 65535 f ',
    ...Array.from({ length: total }, (_, i) => `${String(offsets[i + 1]).padStart(10, '0')} 00000 n `),
  ].join('\n');

  partes.push(aLatin1(`${xref}\ntrailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(partes));
}
