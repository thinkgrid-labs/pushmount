//! Node binding for [`aghoz_core`].
//!
//! Deliberately does **not** go through the C ABI. `napi-rs` is a Rust crate, so this
//! can depend on the core directly — which is both faster (no pointer marshalling, no
//! double indirection) and safer (no unsafe of our own; the macros own it). The C ABI
//! exists for hosts that can only speak C: Go through cgo, Ruby through FFI, Python
//! through ctypes.
//!
//! Nothing here makes protocol decisions. It converts types, and everything else is a
//! call into the core, so the conformance corpus still governs behaviour.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use aghoz_core::{
    BufferVerdict, Checkpoint, EventId, Hub as CoreHub, HubConfig, OriginError, PublishError,
    SubscribeError, SubscriberId, TopicError,
};

/// Options mirroring `HubConfig`. Absent fields take the core's defaults.
#[napi(object)]
#[derive(Default)]
pub struct JsHubConfig {
    /// Bytes of history retained. Bytes, not events.
    pub max_history_bytes: Option<u32>,
    /// Queued bytes before a subscriber is a slow consumer.
    pub max_buffer_bytes: Option<u32>,
    /// Connections per process.
    pub max_connections: Option<u32>,
    /// Connections per key.
    pub max_connections_per_key: Option<u32>,
    /// Topics per connection.
    pub max_topics_per_connection: Option<u32>,
}

/// What a publish produced.
#[napi(object)]
pub struct JsPublish {
    /// The assigned id, formatted `<ms>-<seq>`.
    pub id: String,
    /// The encoded frame, ready to write to a socket.
    pub frame: Buffer,
    /// Subscriber ids the frame should go to.
    pub targets: Vec<u32>,
}

/// What a subscribe produced.
#[napi(object)]
pub struct JsSubscribe {
    /// The registered subscriber.
    pub id: u32,
    /// `"absent"`, `"echo"` or `"earliest"` — what the checkpoint header must say.
    pub checkpoint: String,
    /// Frames to replay, oldest first.
    pub replay: Vec<Buffer>,
}

fn topic_message(e: TopicError) -> String {
    match e {
        TopicError::Empty => "topic is empty",
        TopicError::TooLong => "topic exceeds 255 bytes",
        TopicError::ControlCharacter => "topic contains a control character",
        TopicError::ReservedPrefix => "topic begins with the reserved '~'",
    }
    .to_string()
}

/// Maps a publish rejection onto the message `core-native.ts` matches on.
///
/// The messages are part of the binding's contract rather than incidental strings; the
/// parity tests assert them.
fn publish_message(e: PublishError) -> String {
    match e {
        PublishError::Topic(t) => topic_message(t),
        PublishError::Origin(o) => match o {
            OriginError::Empty => "origin is empty".to_string(),
            OriginError::TooLong => "origin exceeds 64 bytes".to_string(),
            OriginError::ControlCharacter => "origin contains a control character".to_string(),
        },
    }
}

/// The in-process hub.
#[napi]
pub struct Hub {
    inner: CoreHub,
}

#[napi]
impl Hub {
    /// Creates a hub.
    #[napi(constructor)]
    pub fn new(config: Option<JsHubConfig>) -> Hub {
        let c = config.unwrap_or_default();
        let d = HubConfig::default();
        Hub {
            inner: CoreHub::new(HubConfig {
                max_history_bytes: c.max_history_bytes.map_or(d.max_history_bytes, |v| v as usize),
                max_buffer_bytes: c.max_buffer_bytes.map_or(d.max_buffer_bytes, |v| v as usize),
                max_connections: c.max_connections.map_or(usize::MAX, |v| v as usize),
                max_connections_per_key: c
                    .max_connections_per_key
                    .map_or(usize::MAX, |v| v as usize),
                max_topics_per_connection: c
                    .max_topics_per_connection
                    .map_or(d.max_topics_per_connection, |v| v as usize),
            }),
        }
    }

    /// Assigns an id, encodes a frame, and matches subscribers.
    ///
    /// `now_ms` is f64 rather than u64 on purpose: a u64 would surface in JavaScript as
    /// a BigInt, forcing `hub.publish(BigInt(Date.now()), ...)` on every caller and
    /// costing a boxed allocation per publish. f64 is exact for every integer below
    /// 2^53, and Unix milliseconds do not reach that until the year 287396.
    #[napi]
    pub fn publish(
        &mut self,
        now_ms: f64,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<JsPublish> {
        // Empty means absent, matching the ABI and the TypeScript core: JavaScript
        // callers produce `''` wherever a value was missing.
        let origin = origin.filter(|o| !o.is_empty());
        match self.inner.publish(now_ms as u64, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(effect) => Ok(JsPublish {
                id: effect.id.to_string(),
                frame: effect.frame.into(),
                targets: effect.targets.iter().map(|s| s.0 as u32).collect(),
            }),
        }
    }

    /// Records an event whose id a backplane assigned, and returns who should get it.
    ///
    /// The id arrives as its canonical `<ms>-<seq>` text and is parsed here rather than
    /// in TypeScript. §2.1's canonical form — no padding, no signs, no exponents — is
    /// precisely the kind of rule D3 exists to keep in exactly one place.
    #[napi]
    pub fn append(
        &mut self,
        id: String,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<JsPublish> {
        let Some(parsed) = EventId::parse(&id) else {
            return Err(Error::new(Status::InvalidArg, format!("malformed id: {id}")));
        };
        let origin = origin.filter(|o| !o.is_empty());
        match self.inner.append(parsed, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(effect) => Ok(JsPublish {
                id: effect.id.to_string(),
                frame: effect.frame.into(),
                targets: effect.targets.iter().map(|s| s.0 as u32).collect(),
            }),
        }
    }

    /// Encodes a frame for an event whose id was assigned elsewhere, recording nothing.
    ///
    /// Replay from a *shared* history needs the bytes and nothing else — those events are
    /// already in the shared log. Going through `append` for this instead duplicates them
    /// into the local ring on every reconnect, out of id order.
    #[napi]
    pub fn encode(
        &self,
        id: String,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<Buffer> {
        let Some(parsed) = EventId::parse(&id) else {
            return Err(Error::new(Status::InvalidArg, format!("malformed id: {id}")));
        };
        let origin = origin.filter(|o| !o.is_empty());
        match self.inner.encode(parsed, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(bytes) => Ok(bytes.into()),
        }
    }

    /// Registers a subscriber, decides the checkpoint, and snapshots the replay set.
    ///
    /// One call, because §4.5 requires the three to describe one instant. Exposing them
    /// separately would let a caller interleave an `await` and reintroduce exactly the
    /// race this prevents.
    #[napi]
    pub fn subscribe(
        &mut self,
        topics: Vec<String>,
        key: Option<String>,
        cursor: Option<String>,
    ) -> Result<JsSubscribe> {
        let parsed = match cursor.as_deref() {
            None => None,
            Some(raw) => match EventId::parse(raw) {
                Some(id) => Some(id),
                // A malformed cursor must not be treated as "no cursor": the client
                // would believe it resumed and would never be told otherwise.
                None => return Err(Error::new(Status::InvalidArg, "malformed cursor")),
            },
        };

        match self.inner.subscribe(topics, key, parsed) {
            Err(SubscribeError::Topic(t)) => Err(Error::new(Status::InvalidArg, topic_message(t))),
            Err(SubscribeError::TopicCount) => {
                Err(Error::new(Status::InvalidArg, "too-many-topics"))
            }
            Err(SubscribeError::MaxConnections) => {
                Err(Error::new(Status::GenericFailure, "max-connections"))
            }
            Err(SubscribeError::MaxConnectionsPerKey) => {
                Err(Error::new(Status::GenericFailure, "max-connections-per-key"))
            }
            Ok(effect) => Ok(JsSubscribe {
                id: effect.id.0 as u32,
                checkpoint: match effect.checkpoint {
                    Checkpoint::Absent => "absent".to_string(),
                    Checkpoint::Echo(_) => "echo".to_string(),
                    Checkpoint::Earliest => "earliest".to_string(),
                },
                replay: effect.replay.into_iter().map(Buffer::from).collect(),
            }),
        }
    }

    /// Reports a subscriber's *absolute* queued depth. Returns `"ok"`, `"slow-consumer"`
    /// or `"unknown"`.
    ///
    /// What the Node handler uses, because `res.writableLength` is exactly this and the
    /// socket is a better authority than any accounting kept alongside it.
    #[napi]
    pub fn note_buffer(&mut self, subscriber: u32, queued_bytes: f64) -> String {
        verdict_name(
            self.inner
                .note_buffer(SubscriberId(subscriber as u64), queued_bytes as usize),
        )
    }

    /// Reports that `bytes` were handed to the transport, with no absolute depth known.
    ///
    /// Node does not need this — it is here so the corpus can drive the same rule through
    /// this binding that a ctypes or cgo binding will drive through the C ABI.
    #[napi]
    pub fn note_sent(&mut self, subscriber: u32, bytes: f64) -> String {
        verdict_name(self.inner.note_sent(SubscriberId(subscriber as u64), bytes as usize))
    }

    /// Reports that `bytes` previously passed to `noteSent` have drained.
    #[napi]
    pub fn note_flushed(&mut self, subscriber: u32, bytes: f64) -> String {
        verdict_name(self.inner.note_flushed(SubscriberId(subscriber as u64), bytes as usize))
    }

    /// Removes a subscriber. Idempotent.
    #[napi]
    pub fn remove(&mut self, subscriber: u32) -> bool {
        self.inner.remove(SubscriberId(subscriber as u64))
    }

    /// The newest assigned id, or `0-0`.
    #[napi]
    pub fn cursor(&self) -> String {
        self.inner.cursor().to_string()
    }

    /// Open subscribers.
    #[napi]
    pub fn connection_count(&self) -> u32 {
        self.inner.connection_count() as u32
    }

    /// A `~gap` frame for a subscriber that fell behind.
    #[napi]
    pub fn slow_consumer_frame(&self, subscriber: u32) -> Buffer {
        self.inner
            .slow_consumer_frame(SubscriberId(subscriber as u64))
            .into()
    }

    /// A `~gap` frame for a cursor history no longer reaches.
    #[napi]
    pub fn truncated_frame(&self, subscriber: u32) -> Buffer {
        self.inner
            .truncated_frame(SubscriberId(subscriber as u64))
            .into()
    }

    /// A `~denied` frame naming refused topics.
    #[napi]
    pub fn denied_frame(&self, topics: Vec<String>) -> Buffer {
        self.inner.denied_frame(&topics).into()
    }
}

/// One mapping for all three backpressure entry points, so they cannot disagree.
fn verdict_name(verdict: BufferVerdict) -> String {
    match verdict {
        BufferVerdict::Ok => "ok",
        BufferVerdict::SlowConsumer => "slow-consumer",
        BufferVerdict::Unknown => "unknown",
    }
    .to_string()
}

/// §3 — exposed so the HTTP layer can reject a topic before opening a stream.
#[napi]
pub fn validate_topic(topic: String) -> bool {
    aghoz_core::validate_topic(&topic).is_ok()
}

/// §6.0 — exposed so the HTTP layer can reject an origin before it reaches a frame.
#[napi]
pub fn validate_origin(origin: String) -> bool {
    aghoz_core::validate_origin(&origin).is_ok()
}

/// §2.1 — whether a string is a canonical id at all.
///
/// Exposed for the corpus, which pins this rule in its own group: a cursor and a
/// backplane-assigned id both reach the wire, and "which strings are ids" is the kind of
/// thing each language answers differently unless something holds them to one answer.
#[napi]
pub fn validate_id(id: String) -> bool {
    EventId::parse(&id).is_some()
}

/// §2.1 — compares two ids, returning -1, 0 or 1.
#[napi]
pub fn compare_ids(a: String, b: String) -> i32 {
    match (EventId::parse(&a), EventId::parse(&b)) {
        (Some(x), Some(y)) => match x.cmp(&y) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        },
        _ => 0,
    }
}

/// Encodes a frame directly, for the conformance runner.
#[napi]
pub fn encode_frame(
    ms: f64,
    seq: f64,
    topic: String,
    payload: String,
    origin: Option<String>,
) -> Buffer {
    aghoz_core::encode_frame(
        EventId { ms: ms as u64, seq: seq as u64 },
        &topic,
        &payload,
        origin.as_deref(),
    )
    .into()
}
