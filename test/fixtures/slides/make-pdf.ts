// A tiny PDF writer for the slides tests: pages of text (Helvetica, a standard font, not embedded), filled
// rectangles, images (a JPEG2000 one, a huge one and a broken one), annotations, page labels, an OpenAction, and
// the PDF standard security handler (RC4, 40 bits) for the password tests. Everything the tests convert is made
// here, at test time, so no real deck and no third-party content is ever committed.
import crypto from 'node:crypto'

export interface TextSpec {
  text: string
  /** Font size in points. */
  size: number
  x?: number
  /** From the bottom of the page, as PDF has it. */
  y?: number
}

export interface RectSpec {
  x: number
  y: number
  w: number
  h: number
  /** 0 to 1 each. */
  rgb: [number, number, number]
}

export type ImageSpec =
  /** A JPEG2000 image (JPXDecode), drawn at x, y, w, h on the page. */
  | { kind: 'jpx'; data: Buffer; width: number; height: number; at: [number, number, number, number] }
  /** An image that claims width x height pixels, so pdf.js leaves it out unread when that is over its limit. */
  | { kind: 'huge'; width: number; height: number; at: [number, number, number, number] }
  /** A JPEG (DCTDecode) whose bytes are not a JPEG, so it can't be decoded. */
  | { kind: 'broken'; at: [number, number, number, number] }

export type AnnotSpec =
  /** A sticky note, as `marp --pdf --pdf-notes` writes speaker notes. */
  | { kind: 'note'; contents: string }
  | { kind: 'link'; uri: string }
  | { kind: 'launch'; file: string }

export interface PageSpec {
  /** Width and height in points: 960 x 540 (16:9) unless given. */
  size?: [number, number]
  /** Drawn first, in order. */
  rects?: RectSpec[]
  images?: ImageSpec[]
  texts?: TextSpec[]
  annots?: AnnotSpec[]
}

export interface PdfOptions {
  /** One label per page (a /P prefix each), as Beamer-style decks have them. */
  pageLabels?: string[]
  /** JavaScript run when the document opens, in a viewer that runs it (pdf.js never does). */
  openActionJs?: string
  /** The standard security handler: a user password to open it ('' opens it without one), and an owner password. */
  encrypt?: { user: string; owner: string }
}

// The padding string of the standard security handler (ISO 32000-1, 7.6.3.3).
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
const padded = (password: string) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32)
const md5 = (...parts: Buffer[]) => crypto.createHash('md5').update(Buffer.concat(parts)).digest()

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

const literal = (text: string) => `(${text.replace(/[()\\]/g, '\\$&')})`

class Writer {
  private bodies: string[] = []
  private streams: (Buffer | null)[] = []
  private key: Buffer | null = null
  encryptDict = ''
  id = crypto.createHash('md5').update('agent-voice slides test').digest()

  reserve(): number {
    this.bodies.push('')
    this.streams.push(null)
    return this.bodies.length
  }

  set(n: number, body: string, stream?: Buffer) {
    this.bodies[n - 1] = body
    this.streams[n - 1] = stream ?? null
  }

  add(body: string, stream?: Buffer): number {
    const n = this.reserve()
    this.set(n, body, stream)
    return n
  }

  /** A string in object n: plain, or encrypted with that object's key. */
  str(n: number, text: string): string {
    if (!this.key) return literal(text)
    return `<${rc4(this.objectKey(n), Buffer.from(text, 'latin1')).toString('hex')}>`
  }

  encrypt(user: string, owner: string) {
    const permissions = -44 // no printing, no copying
    const o = rc4(md5(padded(owner)).subarray(0, 5), padded(user))
    const p = Buffer.alloc(4)
    p.writeInt32LE(permissions)
    this.key = md5(padded(user), o, p, this.id).subarray(0, 5)
    const u = rc4(this.key, PAD)
    this.encryptDict = `<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${permissions} >>`
  }

  private objectKey(n: number): Buffer {
    const key = this.key as Buffer
    const extra = Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, 0])
    return md5(key, extra).subarray(0, Math.min(16, key.length + 5))
  }

  build(root: number, encryptObj: number | null): Buffer {
    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
    let length = chunks[0].length
    const offsets: number[] = []
    const push = (b: Buffer) => {
      chunks.push(b)
      length += b.length
    }
    this.bodies.forEach((body, i) => {
      const n = i + 1
      offsets.push(length)
      let stream = this.streams[i]
      if (stream && this.key && n !== encryptObj) stream = rc4(this.objectKey(n), stream)
      if (stream) {
        push(Buffer.from(`${n} 0 obj\n${body.replace(/>>\s*$/, '')} /Length ${stream.length} >>\nstream\n`, 'latin1'))
        push(stream)
        push(Buffer.from('\nendstream\nendobj\n', 'latin1'))
      } else {
        push(Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, 'latin1'))
      }
    })
    const xref = length
    const id = this.id.toString('hex')
    push(Buffer.from(
      `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
        `trailer\n<< /Size ${this.bodies.length + 1} /Root ${root} 0 R /ID [<${id}> <${id}>]${encryptObj ? ` /Encrypt ${encryptObj} 0 R` : ''} >>\n` +
        `startxref\n${xref}\n%%EOF\n`,
      'latin1',
    ))
    return Buffer.concat(chunks)
  }
}

/** A PDF of these pages. */
export function makePdf(pages: PageSpec[], opts: PdfOptions = {}): Buffer {
  const w = new Writer()
  if (opts.encrypt) w.encrypt(opts.encrypt.user, opts.encrypt.owner)
  const catalog = w.reserve()
  const pagesObj = w.reserve()
  const font = w.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const page of pages) {
    const [width, height] = page.size ?? [960, 540]
    const xobjects: string[] = []
    const ops: string[] = []
    for (const r of page.rects ?? []) ops.push(`${r.rgb.join(' ')} rg ${r.x} ${r.y} ${r.w} ${r.h} re f`)
    ;(page.images ?? []).forEach((image, i) => {
      const name = `Im${i}`
      let obj: number
      if (image.kind === 'jpx') {
        obj = w.add(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /Filter /JPXDecode >>`, image.data)
      } else if (image.kind === 'huge') {
        obj = w.add(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 >>`,
          Buffer.alloc(16),
        )
      } else {
        obj = w.add(
          '<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>',
          Buffer.from('this is not a jpeg at all, just some bytes'),
        )
      }
      xobjects.push(`/${name} ${obj} 0 R`)
      const [x, y, iw, ih] = image.at
      ops.push(`q ${iw} 0 0 ${ih} ${x} ${y} cm /${name} Do Q`)
    })
    // Each text below the one before it, unless placed.
    let cursor = height - 40
    for (const t of page.texts ?? []) {
      const x = t.x ?? 60
      const y = t.y ?? cursor - t.size
      cursor = y - t.size * 0.6
      ops.push(`0 0 0 rg BT /F1 ${t.size} Tf ${x} ${y} Td ${literal(t.text)} Tj ET`)
    }
    const content = w.reserve()
    w.set(content, '<< >>', Buffer.from(ops.join('\n'), 'latin1'))
    const pageObj = w.reserve()
    const annots = (page.annots ?? []).map(a => {
      const n = w.reserve()
      if (a.kind === 'note') w.set(n, `<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents ${w.str(n, a.contents)} /Open false >>`)
      else if (a.kind === 'link') w.set(n, `<< /Type /Annot /Subtype /Link /Rect [60 60 300 90] /Border [0 0 0] /A << /S /URI /URI ${w.str(n, a.uri)} >> >>`)
      else w.set(n, `<< /Type /Annot /Subtype /Link /Rect [60 100 300 130] /Border [0 0 0] /A << /S /Launch /F ${w.str(n, a.file)} >> >>`)
      return n
    })
    w.set(
      pageObj,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 ${font} 0 R >>${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''} >> ` +
        `/Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map(a => `${a} 0 R`).join(' ')}]` : ''} >>`,
    )
    kids.push(pageObj)
  }
  let extra = ''
  if (opts.pageLabels) {
    const nums = opts.pageLabels.map((label, i) => `${i} << /P ${w.str(catalog, label)} >>`).join(' ')
    extra += ` /PageLabels << /Nums [${nums}] >>`
  }
  if (opts.openActionJs) {
    const js = w.reserve()
    w.set(js, `<< /Type /Action /S /JavaScript /JS ${w.str(js, opts.openActionJs)} >>`)
    extra += ` /OpenAction ${js} 0 R`
  }
  w.set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R${extra} >>`)
  w.set(pagesObj, `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  let encryptObj: number | null = null
  if (opts.encrypt) encryptObj = w.add(w.encryptDict)
  return w.build(catalog, encryptObj)
}
