/**
 * @aghoz/history-file
 *
 * A [`HistoryStore`] backed by an append-only file, so replay survives a restart.
 *
 * ## Read this before reaching for it
 *
 * **A Redis backplane already does this**, and better: a Redis stream is a persistent
 * shared history, so anything running more than one process is covered by `@aghoz/redis`
 * and should use that. This is for the single-process deployment that does not want
 * Redis, which is the one case the backplane leaves out.
 *
 * **It is pointless on an ephemeral filesystem.** A container that starts from a fresh
 * image every deploy has no file to load, so this silently does nothing useful. It needs
 * a volume that outlives the process.
 *
 * ## What it guarantees, and what it deliberately does not
 *
 * Writes are appended as they happen and are **not** fsynced per event by default. A hard
 * crash can therefore lose the tail of the log.
 *
 * That is a deliberate trade rather than a corner cut, and it remains safe because a
 * process removes the previous run's clean certificate before it serves or publishes. A
 * crash leaves no certificate, so the next hub treats even a valid-looking prefix as
 * uncertain and tells every resuming client to refetch. A graceful close drains and syncs
 * the log before issuing a new certificate, so ordinary deploys still replay normally.
 * Durability here buys fewer refetches, never correctness; set `fsync: true` if your
 * operational story wants every individual append durable too.
 *
 * A partially written final line — the ordinary result of a crash mid-append — is dropped
 * on load rather than treated as corruption. Anything else would turn a routine crash into
 * a hub that refuses to start.
 */

import { open, rename, stat, readFile, unlink, type FileHandle } from 'node:fs/promises'
import type { HistoryStore, LoadedHistory, StoredEvent } from '@aghoz/server'

/**
 * The header line a compacted log carries, recording what compaction threw away.
 *
 * Written down rather than recomputed because it cannot be recomputed: once the oldest
 * lines are gone, nothing in the file says they ever existed. Without it a restored hub
 * would tell a client whose events were compacted away that it had missed nothing.
 */
interface TrimMarker {
  readonly trimmed: string
}

export interface FileStoreOptions {
  /** The log file. Its directory must already exist. */
  path: string
  /**
   * Bytes of log to keep. Default 8 MiB, matching the hub's own history budget.
   *
   * The log is compacted when it grows past twice this, so the steady state sits between
   * one and two times the value. Rewriting on every overflow instead would rewrite the
   * whole file on every publish once full.
   */
  maxBytes?: number
  /**
   * fsync after every append. Default false — an unclean recovery forces a gap rather
   * than trusting a possibly short tail.
   */
  fsync?: boolean
}

export function createFileStore(options: FileStoreOptions): HistoryStore {
  const path = options.path
  const cleanPath = `${path}.clean`
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const shouldSync = options.fsync ?? false

  let handle: FileHandle | undefined
  let bytes = 0
  let closed = false
  let closing: Promise<void> | undefined
  /**
   * Appends are serialised through this.
   *
   * `append` is called from the publish path and is not awaited, so several can be in
   * flight at once. Two concurrent writes to one handle can interleave inside a line, and
   * a torn line is an event lost — chained instead, which also keeps the file in publish
   * order, the order `load` is required to return.
   */
  let tail: Promise<void> = Promise.resolve()

  async function handleFor(): Promise<FileHandle> {
    if (handle === undefined) {
      handle = await open(path, 'a')
      bytes = await size(path)
    }
    return handle
  }

  return {
    async load(): Promise<LoadedHistory> {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        // No file is the ordinary first-boot case, not a failure.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [] }
        throw error
      }

      // A clean marker is a certificate from the previous process: it drained and synced
      // the log before exiting. Remove it before this process serves or publishes, so a
      // crash in this run leaves the next recovery conservative rather than trusting an
      // earlier process's certificate.
      let clean = false
      try {
        clean = (await readFile(cleanPath, 'utf8')).trim() === 'clean'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (clean) await unlink(cleanPath)

      const events: StoredEvent[] = []
      let trimmed: string | undefined
      let tornTail = false
      const lines = raw.split('\n')
      for (const [i, line] of lines.entries()) {
        if (line === '') continue
        try {
          const parsed = JSON.parse(line) as StoredEvent & Partial<TrimMarker>
          if (typeof parsed.trimmed === 'string') {
            trimmed = parsed.trimmed
          } else if (typeof parsed.id === 'string' && typeof parsed.topic === 'string') {
            events.push(parsed)
          }
        } catch {
          // Only the last line may be torn — that is a crash mid-append, and dropping it
          // is correct. A broken line anywhere else means the file is not what we think
          // it is, and reading on would silently skip real events.
          if (i !== lines.length - 1) {
            throw new Error(`aghoz: ${path} is corrupt at line ${i + 1}`)
          }
          tornTail = true
        }
      }
      return {
        events,
        ...(trimmed !== undefined && { trimmed }),
        ...(clean && !tornTail ? {} : { uncertain: true }),
      }
    },

    append(event: StoredEvent): Promise<void> {
      if (closed) return Promise.resolve()
      // No `closed` check inside the chain. Appends are not awaited by the hub, so by the
      // time one reaches the front of the queue a `close()` may have been called behind
      // it — and dropping it there would silently discard events that were accepted while
      // the store was open. `close()` drains this queue instead of racing it.
      tail = tail.then(async () => {
        const line = `${JSON.stringify(event)}\n`
        const h = await handleFor()
        await h.write(line)
        if (shouldSync) await h.sync()
        bytes += Buffer.byteLength(line)
        if (bytes > maxBytes * 2) await compact()
      })
      return tail
    },

    close(): Promise<void> {
      if (closing !== undefined) return closing
      closed = true
      closing = (async () => {
        // A failed write must never produce a clean certificate: a later process has a
        // prefix, not a complete log, and must report a gap rather than trusting it.
        await tail
        // `fsync: false` is still fine during a run, but a clean certificate needs the
        // bytes it certifies to be durable before it is written.
        await handle?.sync()
        await handle?.close()
        handle = undefined
        await writeCleanMarker()
      })()
      return closing
    },
  }

  async function writeCleanMarker(): Promise<void> {
    const temp = `${cleanPath}.tmp`
    const marker = await open(temp, 'w')
    try {
      await marker.write('clean\n')
      await marker.sync()
    } finally {
      await marker.close()
    }
    await rename(temp, cleanPath)
  }

  /**
   * Rewrites the log keeping only its newest `maxBytes`, atomically.
   *
   * Temp file plus rename, because a crash partway through an in-place rewrite would
   * leave a log that is neither the old one nor the new one.
   */
  async function compact(): Promise<void> {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')

    // An existing marker is carried forward until a later drop supersedes it, so the
    // floor only ever moves in one direction across repeated compactions.
    let marker: string | undefined
    const entries: string[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as StoredEvent & Partial<TrimMarker>
        if (typeof parsed.trimmed === 'string') marker = parsed.trimmed
        else entries.push(line)
      } catch {
        // A torn tail. It is about to be rewritten away.
      }
    }

    let kept: string[] = []
    let total = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      const line = entries[i] as string
      const n = Buffer.byteLength(line) + 1
      if (total + n > maxBytes) break
      kept.push(line)
      total += n
    }
    kept = kept.reverse()

    // Whatever fell off the front is gone for good, so the newest of those becomes the
    // floor the hub reports gaps against.
    const dropped = entries.slice(0, entries.length - kept.length)
    if (dropped.length > 0) {
      const last = dropped[dropped.length - 1] as string
      marker = (JSON.parse(last) as StoredEvent).id
    }

    const header = marker === undefined ? '' : `${JSON.stringify({ trimmed: marker })}\n`
    const temp = `${path}.compact`
    const out = await open(temp, 'w')
    try {
      await out.write(kept.length === 0 ? header : `${header}${kept.join('\n')}\n`)
      await out.sync()
    } finally {
      await out.close()
    }
    total += Buffer.byteLength(header)

    await handle?.close()
    handle = undefined
    await rename(temp, path)
    bytes = total
  }
}

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Deletes a store's file. For tests and for an operator who wants a clean slate. */
export async function removeFileStore(path: string): Promise<void> {
  for (const p of [path, `${path}.compact`, `${path}.clean`, `${path}.clean.tmp`]) {
    try {
      await unlink(p)
    } catch {
      // Already gone.
    }
  }
}
