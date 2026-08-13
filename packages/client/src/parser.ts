/**
 * The SSE frame parser — PROTOCOL.md §6.3.
 *
 * Written rather than borrowed because `EventSource` cannot read response headers, and
 * the checkpoint that reports data loss is a header (§4.4). Owning the parser is the
 * price of gap detection, so it has to be right about the cases that only appear over
 * a real network: a chunk boundary landing mid-line, mid-field-name, or between the
 * two bytes of a CRLF.
 */

export interface ParsedEvent {
  /** Absent on control frames (§7), which must never advance a cursor. */
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

export class SseParser {
  #buffer = ''
  readonly #decoder = new TextDecoder()

  #id: string | undefined
  #event: string | undefined
  #data: string[] = []
  #sawField = false

  /** Feeds one chunk and returns any completed events. */
  push(chunk: Uint8Array): ParsedEvent[] {
    // `stream: true` is what stops a multibyte character split across chunks from
    // decoding as two replacement characters.
    this.#buffer += this.#decoder.decode(chunk, { stream: true })
    return this.#drain(false)
  }

  /** Call when the stream ends, to release a final line with no trailing newline. */
  end(): ParsedEvent[] {
    this.#buffer += this.#decoder.decode()
    return this.#drain(true)
  }

  #drain(final: boolean): ParsedEvent[] {
    const out: ParsedEvent[] = []

    for (;;) {
      const i = firstLineBreak(this.#buffer)
      if (i === -1) break

      // A trailing CR may be the first half of a CRLF. Treating it as a line end now
      // would emit an event, then see a stray LF and emit a second, empty one.
      if (this.#buffer.charCodeAt(i) === 13 && i === this.#buffer.length - 1 && !final) break

      const line = this.#buffer.slice(0, i)
      const skip = this.#buffer.charCodeAt(i) === 13 && this.#buffer.charCodeAt(i + 1) === 10 ? 2 : 1
      this.#buffer = this.#buffer.slice(i + skip)

      const event = this.#line(line)
      if (event !== null) out.push(event)
    }

    if (final && this.#buffer.length > 0) {
      const event = this.#line(this.#buffer)
      this.#buffer = ''
      if (event !== null) out.push(event)
    }
    return out
  }

  #line(line: string): ParsedEvent | null {
    if (line === '') return this.#dispatch()
    if (line.charCodeAt(0) === 58) return null // ':' comment — §6.2

    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1) // one optional space

    switch (name) {
      case 'id':
        this.#id = value
        this.#sawField = true
        break
      case 'event':
        this.#event = value
        this.#sawField = true
        break
      case 'data':
        this.#data.push(value)
        this.#sawField = true
        break
      default:
        // §11 — unknown fields are ignored, and must not count as content.
        break
    }
    return null
  }

  #dispatch(): ParsedEvent | null {
    if (!this.#sawField) return null

    const event: ParsedEvent = {
      id: this.#id,
      event: this.#event,
      // §6.1 — segments rejoin with LF, which is why CR and CRLF are lossy on the way out.
      data: this.#data.join('\n'),
    }

    this.#id = undefined
    this.#event = undefined
    this.#data = []
    this.#sawField = false
    return event
  }
}

function firstLineBreak(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 10 || c === 13) return i
  }
  return -1
}

/**
 * §2.1 — id comparison. Duplicated from the server rather than imported: C7 requires
 * the client to have zero runtime dependencies, and the shared conformance corpus is
 * what keeps the two copies honest.
 */
export function compareIds(a: string, b: string): number {
  const av = splitId(a)
  const bv = splitId(b)
  if (av === null || bv === null) return a === b ? 0 : a < b ? -1 : 1
  if (av[0] !== bv[0]) return av[0] < bv[0] ? -1 : 1
  if (av[1] !== bv[1]) return av[1] < bv[1] ? -1 : 1
  return 0
}

function splitId(raw: string): [number, number] | null {
  const dash = raw.indexOf('-')
  if (dash <= 0 || dash === raw.length - 1) return null
  const ms = Number(raw.slice(0, dash))
  const seq = Number(raw.slice(dash + 1))
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(seq)) return null
  return [ms, seq]
}
