// A strict reader for the YAML this repo commits for GitHub Actions (.github/workflows/*.yml), so the tests can check
// those files without a YAML dependency. It takes block mappings and sequences by indentation, literal block scalars
// (| and |-), flow sequences of scalars ([a, "b"]), plain, single- and double-quoted scalars, and comments. Plain
// true, false, null and integers are read as such; every other plain scalar is a string (on, yes and no included, as
// GitHub reads them). Anything else (anchors, aliases, tags, flow mappings, folded scalars, a key set twice, a tab in
// the indentation) is an error, never a guess.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap
export type YamlMap = { [key: string]: YamlValue }

export function parseYaml(text: string): YamlValue {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const fail = (why: string, at = i): never => {
    throw new Error(`YAML line ${at + 1}: ${why}`)
  }
  const indentOf = (line: string) => {
    const m = /^( *)(\t?)/.exec(line) as RegExpExecArray
    if (m[2]) fail('a tab in the indentation')
    return m[1].length
  }
  const blank = (line: string) => /^\s*(#.*)?$/.test(line)
  // The next line that holds something: blank lines and comment lines are skipped between nodes.
  const next = (): { indent: number; content: string } | null => {
    while (i < lines.length && blank(lines[i])) i++
    if (i >= lines.length) return null
    const indent = indentOf(lines[i])
    return { indent, content: lines[i].slice(indent) }
  }
  // A comment starts at a # with a space (or the line's start) before it, outside quotes.
  const stripComment = (s: string): string => {
    let quote = ''
    for (let k = 0; k < s.length; k++) {
      const c = s[k]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") {
        if (k === 0 || /[\s[,]/.test(s[k - 1])) quote = c
      } else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd()
    }
    return s.trimEnd()
  }
  const doubleQuoted = (s: string): [string, string] => {
    let out = ''
    let k = 1
    const simple: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', r: '\r', '0': '\0' }
    for (; k < s.length && s[k] !== '"'; k++) {
      if (s[k] !== '\\') out += s[k]
      else if (s[++k] in simple) out += simple[s[k]]
      else fail(`an escape this reader doesn't take: \\${s[k]}`)
    }
    if (s[k] !== '"') fail('a double-quoted string that doesn\'t end on its line')
    return [out, s.slice(k + 1)]
  }
  const singleQuoted = (s: string): [string, string] => {
    let out = ''
    let k = 1
    for (; k < s.length; k++) {
      if (s[k] === "'") {
        if (s[k + 1] === "'") {
          out += "'"
          k++
        } else break
      } else out += s[k]
    }
    if (s[k] !== "'") fail("a single-quoted string that doesn't end on its line")
    return [out, s.slice(k + 1)]
  }
  const plain = (s: string): YamlValue => {
    if (/^[&*!|>%@`{]/.test(s)) fail(`a value this reader doesn't take: ${s}`)
    if (/: |:$/.test(s)) fail(`a ": " in a plain value: ${s}`)
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null' || s === '~' || s === '') return null
    if (/^-?(0|[1-9]\d*)$/.test(s)) return Number(s)
    return s
  }
  // A scalar or a flow sequence, the whole of what follows a key or a "- " on its line.
  const inline = (raw: string): YamlValue => {
    const s = raw.trim()
    if (s.startsWith('"') || s.startsWith("'")) {
      const [value, rest] = s.startsWith('"') ? doubleQuoted(s) : singleQuoted(s)
      if (stripComment(rest).trim()) fail(`text after a quoted string: ${rest}`)
      return value
    }
    if (s.startsWith('[')) {
      const body = stripComment(s)
      if (!body.endsWith(']')) fail('a flow sequence that doesn\'t end on its line')
      const inner = body.slice(1, -1).trim()
      if (!inner) return []
      const items: YamlValue[] = []
      let rest = inner
      while (rest) {
        if (rest.startsWith('[') || rest.startsWith('{')) fail('a nested flow collection')
        let item: YamlValue
        if (rest.startsWith('"') || rest.startsWith("'")) {
          const [value, after] = rest.startsWith('"') ? doubleQuoted(rest) : singleQuoted(rest)
          item = value
          rest = after.trim()
        } else {
          const comma = rest.indexOf(',')
          item = plain((comma < 0 ? rest : rest.slice(0, comma)).trim())
          rest = comma < 0 ? '' : rest.slice(comma)
        }
        items.push(item)
        if (rest.startsWith(',')) rest = rest.slice(1).trim()
        else if (rest) fail(`unexpected ${JSON.stringify(rest)} in a flow sequence`)
      }
      return items
    }
    return plain(stripComment(s))
  }
  const blockScalar = (header: string, parent: number): string => {
    if (header !== '|' && header !== '|-') fail(`a block scalar this reader doesn't take: ${header}`)
    i++
    const body: string[] = []
    let indent = -1
    while (i < lines.length) {
      const line = lines[i]
      if (/^\s*$/.test(line)) {
        body.push('')
        i++
        continue
      }
      const ind = indentOf(line)
      if (ind <= parent) break
      if (indent < 0) indent = ind
      if (ind < indent) fail('a block scalar line indented less than its first')
      body.push(line.slice(indent))
      i++
    }
    while (body.length && body.at(-1) === '') body.pop()
    return body.join('\n') + (header === '|' && body.length ? '\n' : '')
  }
  // "key: rest", with the key plain or quoted: the first ": " (or a ":" that ends the line) outside quotes.
  const splitKey = (content: string): [string, string] | null => {
    let key: string
    let rest: string
    if (content.startsWith('"') || content.startsWith("'")) {
      const [value, after] = content.startsWith('"') ? doubleQuoted(content) : singleQuoted(content)
      if (!/^:( |$)/.test(after)) return null
      key = value
      rest = after.slice(1)
    } else {
      const m = /^([^\s#'"[\]{},][^#]*?):( +|$)/.exec(content)
      if (!m) return null
      key = m[1]
      rest = content.slice(m[0].length)
    }
    return [key, rest]
  }
  const valueAfterKey = (rest: string, indent: number): YamlValue => {
    const r = stripComment(rest)
    if (r === '|' || r === '|-' || /^[|>]/.test(r)) return blockScalar(r, indent)
    i++
    if (r) return inline(rest)
    const n = next()
    if (n && n.indent > indent) return block(n.indent)
    // GitHub's files indent sequences under their key, but YAML lets them sit at the key's own indentation.
    if (n && n.indent === indent && /^-( |$)/.test(n.content)) return sequence(indent)
    return null
  }
  const mapping = (indent: number, first?: string): YamlMap => {
    const map: YamlMap = {}
    let content = first
    for (;;) {
      if (content === undefined) {
        const n = next()
        if (!n || n.indent < indent) break
        if (n.indent > indent) fail('a line indented more than its mapping')
        if (/^-( |$)/.test(n.content)) break
        content = n.content
      }
      const kv = splitKey(content)
      if (!kv) fail(`not a "key: value" line: ${content}`)
      const [key, rest] = kv as [string, string]
      if (Object.hasOwn(map, key)) fail(`the key ${JSON.stringify(key)} set twice`)
      map[key] = valueAfterKey(rest, indent)
      content = undefined
    }
    return map
  }
  const sequence = (indent: number): YamlValue[] => {
    const items: YamlValue[] = []
    for (;;) {
      const n = next()
      if (!n || n.indent < indent || !/^-( |$)/.test(n.content)) {
        if (n && n.indent > indent) fail('a line indented more than its sequence')
        break
      }
      if (n.indent > indent) fail('a sequence item indented more than the first')
      const after = n.content.slice(1)
      const rest = after.trimStart()
      if (!stripComment(rest)) {
        i++
        const m = next()
        items.push(m && m.indent > indent ? block(m.indent) : null)
        continue
      }
      // "- key: value" starts a mapping whose other keys line up with this first one.
      const column = indent + 1 + (after.length - rest.length)
      if (splitKey(rest)) items.push(mapping(column, rest))
      else if (/^-( |$)/.test(rest)) fail('a sequence in a sequence item on one line')
      else {
        const r = stripComment(rest)
        items.push(/^[|>]/.test(r) ? blockScalar(r, indent) : (i++, inline(rest)))
      }
    }
    return items
  }
  const block = (indent: number): YamlValue => {
    const n = next()
    if (!n) return null
    return /^-( |$)/.test(n.content) ? sequence(indent) : mapping(indent)
  }
  const first = next()
  if (!first) return null
  if (first.indent !== 0) fail('the document indented')
  const doc = block(0)
  if (next()) fail('a line after the document')
  return doc
}
