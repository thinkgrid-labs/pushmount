# Conformance corpus

The shared test corpus for every implementation of the wire protocol. It is the contract
described in `PROTOCOL.md` §12, and it is the only reason having more than one hub
implementation is a defensible position rather than a slow-motion divergence.

## Layout

```
vectors.json         the corpus — 35 vectors in four groups
build-vectors.mjs    regenerates vectors.json
runner.mjs           runs the corpus against any JavaScript implementation
```

The Rust side reads the same `vectors.json` from
`spikes/wasm-vs-ts/core-rs/tests/conformance.rs`. **A vector added here is enforced on
both implementations automatically.** That property is the whole point; do not fork the
corpus.

## Running it

```sh
node runner.mjs <path-to-module>          # any JS implementation
cargo test --release                      # from a Rust crate that reads the corpus
```

The runner exits non-zero and prints expected-vs-actual for every divergence.

## Groups

| group | count | covers |
|---|---|---|
| `encode` | 12 | §6.1 frame encoding and payload segmentation |
| `topic` | 16 | §3 topic validation |
| `idOrder` | 4 | §2.1 id comparison |
| `monotonic` | 3 | §2.2 clock-regression handling |

## Rules for adding vectors

**Write expected values from the spec, never capture them from an implementation.** A
corpus recorded from a running implementation only proves that implementation is
self-consistent. It cannot catch a bug both implementations would make, and it silently
blesses whatever the first implementation happened to do.

This is not hypothetical. The corpus's first run found a real divergence: **T15**. §3
bounds a topic at 255 **bytes**, but the JavaScript hub measured `topic.length`, which
counts UTF-16 code units. An 86-character Japanese topic is 258 UTF-8 bytes — rejected by
Rust, accepted by JavaScript. Had the corpus been captured from the JavaScript
implementation, the vector would have recorded `valid: true` and enshrined the bug.

Every vector should also carry a `desc` that explains what breaks if it fails. A vector
whose failure message does not tell you what is wrong is worth very little at 3am.

## Vectors that matter most

- **E2** — a payload containing a blank line must not be able to inject an `event:` or
  `id:` field. This is the injection defence; if it regresses, any user-supplied string
  reaching `publish` can forge events for every subscriber.
- **T7** — a topic named `~gap` must be rejected, or a publisher can forge data-loss
  notifications.
- **T15** — the byte/character distinction described above.
- **O1** — `1755083412345-7` sorts before `1755083412345-10`. A string comparison gets
  this backwards, and the failure mode is a client silently discarding live events as
  already-seen.
- **M1** — a backwards system clock must not produce a backwards cursor.
