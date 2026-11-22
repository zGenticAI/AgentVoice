// The literals of JavaScript or TypeScript source, read without running it: for the tests that check what the code says
// (test/no-hardcoded-name.test.ts, test/command-words.test.ts), and never what its comments say.

/** Every string, template and regular expression literal in JavaScript or TypeScript source, with its line. */
export function literals(source: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = []
  let i = 0
  let line = 1
  // The last token, to tell a regular expression from a division.
  let last = ''
  const lineAt = (from: number, to: number) => source.slice(from, to).split('\n').length - 1
  // A regular expression from its opening slash: its text, and i past it.
  const readPattern = (): string => {
    const start = i
    let inClass = false
    for (i++; i < source.length && (source[i] !== '/' || inClass); i++) {
      if (source[i] === '\\') i++
      else if (source[i] === '[') inClass = true
      else if (source[i] === ']') inClass = false
    }
    i++
    return source.slice(start, i)
  }
  const readQuoted = (quote: string, nested = false): void => {
    const start = i
    i++
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') i++
      else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        // An expression in a template: skip to its closing brace, past any strings and patterns in it (a quote mark in
        // a pattern, as in p.replace(/'/g, ...), is not a string).
        let depth = 1
        let before = '{'
        i += 2
        while (i < source.length && depth > 0) {
          if (source[i] === '{') depth++
          else if (source[i] === '}') depth--
          else if (`'"\``.includes(source[i])) {
            readQuoted(source[i], true)
            before = 'literal'
            continue
          } else if (source[i] === '/' && '(,=:[!&|?{};+-*%<>~^'.includes(before)) {
            found.push({ text: readPattern(), line })
            before = 'literal'
            continue
          }
          if (!/\s/.test(source[i])) before = source[i]
          if (depth > 0) i++
        }
      }
      i++
    }
    i++
    // A string in a template's expression is given the template's first line, and its lines counted with the template's.
    found.push({ text: source.slice(start, i), line })
    if (!nested) line += lineAt(start, i)
  }
  while (i < source.length) {
    const c = source[i]
    if (c === '\n') {
      line++
      i++
    } else if (/\s/.test(c)) {
      i++
    } else if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i)
      if (i < 0) break
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i) + 2
      line += lineAt(i, end)
      i = end
    } else if (`'"\``.includes(c)) {
      readQuoted(c)
      last = 'literal'
    } else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || ['return', 'typeof', 'case'].includes(last))) {
      found.push({ text: readPattern(), line })
      last = 'literal'
    } else if (/[\w$]/.test(c)) {
      const start = i
      while (i < source.length && /[\w$]/.test(source[i])) i++
      last = source.slice(start, i)
    } else {
      last = c
      i++
    }
  }
  return found
}
