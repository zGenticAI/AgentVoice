// A strict reader for the TOML this repo commits for Codex (.codex/config.toml, .codex/agents/*.toml), so the tests
// can check those files without a TOML dependency. It takes tables ([a."b c"]), bare, quoted and dotted keys, basic
// and literal strings (one-line and multi-line), integers, floats, booleans, arrays and inline tables, and comments.
// Anything else (arrays of tables, dates, a key set twice) is an error, never a guess.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  let table = root
  let i = 0
  const fail = (why: string): never => {
    const line = text.slice(0, i).split('\n').length
    throw new Error(`TOML line ${line}: ${why}`)
  }
  const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v)
  const skipSpace = () => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  // Spaces, newlines and comments: what may come between values in an array or between lines.
  const skipBlank = () => {
    for (;;) {
      skipSpace()
      if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
      else if (text[i] === '\n' || text[i] === '\r') i++
      else return
    }
  }
  const endOfLine = () => {
    skipSpace()
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
    if (text[i] === '\r') i++
    if (i < text.length && text[i] !== '\n') fail(`unexpected ${JSON.stringify(text[i])} after a value`)
    i++
  }
  const escape = (): string => {
    const c = text[i++]
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
    if (c in simple) return simple[c]
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8
      const hex = text.slice(i, i + n)
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('bad unicode escape')
      i += n
      return String.fromCodePoint(parseInt(hex, 16))
    }
    return fail(`bad escape \\${c}`)
  }
  const string = (): string => {
    if (text.startsWith("'''", i) || text.startsWith('"""', i)) {
      const quote = text.slice(i, i + 3)
      i += 3
      if (text[i] === '\n') i++
      else if (text.startsWith('\r\n', i)) i += 2
      let out = ''
      for (;;) {
        if (i >= text.length) fail('unclosed multi-line string')
        if (text.startsWith(quote, i)) {
          i += 3
          return out
        }
        if (quote === '"""' && text[i] === '\\') {
          i++
          if (/^[ \t]*\r?\n/.test(text.slice(i))) {
            while (/[ \t\r\n]/.test(text[i])) i++
          } else out += escape()
        } else out += text[i++]
      }
    }
    const quote = text[i++]
    let out = ''
    for (;;) {
      if (i >= text.length || text[i] === '\n') fail('unclosed string')
      const c = text[i++]
      if (c === quote) return out
      out += quote === '"' && c === '\\' ? escape() : c
    }
  }
  const key = (): string => {
    skipSpace()
    if (text[i] === '"' || text[i] === "'") {
      if (text.startsWith("'''", i) || text.startsWith('"""', i)) fail('a multi-line string is not a key')
      return string()
    }
    const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i))?.[0]
    if (!bare) fail('expected a key')
    i += bare!.length
    return bare!
  }
  const dottedKey = (): string[] => {
    const parts = [key()]
    for (;;) {
      skipSpace()
      if (text[i] !== '.') return parts
      i++
      parts.push(key())
    }
  }
  const value = (): TomlValue => {
    skipSpace()
    const c = text[i]
    if (c === '"' || c === "'") return string()
    if (c === '[') {
      i++
      const items: TomlValue[] = []
      for (;;) {
        skipBlank()
        if (text[i] === ']') {
          i++
          return items
        }
        items.push(value())
        skipBlank()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('expected , or ] in an array')
      }
    }
    if (c === '{') {
      i++
      const inline: TomlTable = {}
      skipSpace()
      if (text[i] === '}') {
        i++
        return inline
      }
      for (;;) {
        assign(inline, dottedKey())
        skipSpace()
        if (text[i] === '}') {
          i++
          return inline
        }
        if (text[i] !== ',') fail('expected , or } in an inline table')
        i++
      }
    }
    const word = /^[^\s,\]}#]+/.exec(text.slice(i))?.[0] ?? ''
    i += word.length
    if (word === 'true') return true
    if (word === 'false') return false
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(word)) return Number(word.replaceAll('_', ''))
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(word)) return Number(word.replaceAll('_', ''))
    return fail(`a value this reader doesn't take: ${JSON.stringify(word)}`)
  }
  const tableAt = (from: TomlTable, path: string[]): TomlTable => {
    let at = from
    for (const part of path) {
      if (!(part in at)) at[part] = {}
      const next = at[part]
      if (!isTable(next)) fail(`${path.join('.')} is not a table`)
      at = next as TomlTable
    }
    return at
  }
  const assign = (into: TomlTable, path: string[]) => {
    const target = tableAt(into, path.slice(0, -1))
    const last = path.at(-1)!
    skipSpace()
    if (text[i] !== '=') fail('expected =')
    i++
    if (last in target) fail(`${path.join('.')} is set twice`)
    target[last] = value()
  }
  const declared = new Set<string>()
  for (;;) {
    skipBlank()
    if (i >= text.length) return root
    if (text[i] === '[') {
      if (text[i + 1] === '[') fail('arrays of tables are not supported here')
      i++
      const path = dottedKey()
      skipSpace()
      if (text[i] !== ']') fail('expected ] after a table name')
      i++
      const name = JSON.stringify(path)
      if (declared.has(name)) fail(`table [${path.join('.')}] is declared twice`)
      declared.add(name)
      table = tableAt(root, path)
      endOfLine()
      continue
    }
    assign(table, dottedKey())
    endOfLine()
  }
}
