//! The hub — §2, §4.5, §5, §8, §10.

use crate::codec::{encode_control, encode_frame};
use crate::history::{Entry, History};
use crate::id::{EventId, Sequence};
use crate::registry::{Registry, SubscriberId};
use crate::origin::{validate_origin, OriginError};
use crate::topic::{validate_topic, TopicError};

/// Limits, all of which §10 requires to exist even where they default to unbounded.
#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Bytes of history retained. Not a count — see [`crate::Hub`].
    pub max_history_bytes: usize,
    /// Queued bytes past which a subscriber is a slow consumer.
    pub max_buffer_bytes: usize,
    /// Connections per process.
    pub max_connections: usize,
    /// Connections per key, typically per user.
    pub max_connections_per_key: usize,
    /// Topics per connection.
    pub max_topics_per_connection: usize,
}

impl Default for HubConfig {
    fn default() -> Self {
        HubConfig {
            max_history_bytes: 8 * 1024 * 1024,
            max_buffer_bytes: 1024 * 1024,
            max_connections: usize::MAX,
            max_connections_per_key: usize::MAX,
            max_topics_per_connection: 64,
        }
    }
}

/// What a publish produced.
pub struct PublishEffect {
    /// The assigned id.
    pub id: EventId,
    /// The encoded frame, to be written to each target.
    pub frame: Vec<u8>,
    /// Subscribers whose topic set matched.
    pub targets: Vec<SubscriberId>,
}

/// §4.4 — what the `last-event-id-checkpoint` header must say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    /// No cursor was presented; the header is omitted entirely.
    Absent,
    /// History reaches the cursor. Echo it back.
    Echo(EventId),
    /// History no longer reaches it. Send `earliest`, and a `~gap` frame.
    Earliest,
}

/// What a subscription produced. Registration, the checkpoint decision and the replay
/// snapshot are one operation deliberately — see [`Hub::subscribe`].
pub struct SubscribeEffect {
    /// The registered subscriber.
    pub id: SubscriberId,
    /// What the response header must carry.
    pub checkpoint: Checkpoint,
    /// Frames to replay, oldest first.
    pub replay: Vec<Vec<u8>>,
}

/// Why a subscription was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeError {
    /// A topic violated §3. Bindings map this to `400`.
    Topic(TopicError),
    /// Zero topics, or more than `max_topics_per_connection`. `400`.
    TopicCount,
    /// `max_connections` reached. `429`.
    MaxConnections,
    /// `max_connections_per_key` reached. `429`.
    MaxConnectionsPerKey,
}

/// Why a publish was refused.
///
/// Both variants are caller errors rather than request failures: a topic and an origin
/// are supplied by application code, not parsed off the wire, so a binding surfaces these
/// as a thrown error rather than a status code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishError {
    /// A topic violated §3.
    Topic(TopicError),
    /// An origin violated §6.0.
    Origin(OriginError),
}

/// §8.2 — what to do about a subscriber's buffer depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferVerdict {
    /// Keeping up.
    Ok,
    /// Past `max_buffer_bytes`. Write the returned frame, then close.
    SlowConsumer,
    /// No such subscriber — a write that completed after teardown.
    Unknown,
}

/// The in-process hub.
///
/// Not internally synchronised. Node is single-threaded and should not pay for locks it
/// cannot contend; threaded hosts get a mutex in the ABI layer instead.
pub struct Hub {
    config: HubConfig,
    sequence: Sequence,
    history: History,
    registry: Registry,
    targets: Vec<SubscriberId>,
}

impl Hub {
    /// Creates a hub.
    pub fn new(config: HubConfig) -> Hub {
        let history = History::new(config.max_history_bytes);
        Hub {
            config,
            sequence: Sequence::default(),
            history,
            registry: Registry::new(),
            targets: Vec::new(),
        }
    }

    /// §5 — the newest id assigned, or `0-0`.
    ///
    /// Handing this to a page alongside its initial data is what closes the window
    /// between rendering and the stream opening. Without it, anything published in
    /// between is lost with nothing reported — on every first page load.
    pub fn cursor(&self) -> EventId {
        self.sequence.current()
    }

    /// Assigns an id, encodes, appends to history and matches subscribers.
    pub fn publish(
        &mut self,
        now_ms: u64,
        topic: &str,
        payload: &str,
        origin: Option<&str>,
    ) -> Result<PublishEffect, PublishError> {
        validate_topic(topic).map_err(PublishError::Topic)?;
        // Validated before an id is drawn: a rejected publish must not consume one, or
        // the sequence develops holes that look like lost events to anyone auditing it.
        if let Some(origin) = origin.filter(|o| !o.is_empty()) {
            validate_origin(origin).map_err(PublishError::Origin)?;
        }

        let id = self.sequence.next(now_ms);
        let frame = encode_frame(id, topic, payload, origin);

        self.registry.matching(topic, &mut self.targets);
        let targets = self.targets.clone();

        self.history.push(Entry { id, topic: topic.to_string(), frame: frame.clone() });
        Ok(PublishEffect { id, frame, targets })
    }

    /// Registers a subscriber, decides the checkpoint, and snapshots the replay set.
    ///
    /// These are one call because §4.5 requires them to describe one instant. Split
    /// apart, a publish landing in between can trim history after the checkpoint has
    /// already said "nothing was missed" — under-reporting a real gap, which is exactly
    /// the silent staleness this protocol exists to eliminate.
    ///
    /// Registration happens *before* the snapshot, which can deliver one event twice.
    /// That is the intended trade: clients dedupe by id, so a duplicate is a rendering
    /// no-op, whereas the reverse order drops anything published between the two steps
    /// and nothing fails.
    pub fn subscribe(
        &mut self,
        topics: Vec<String>,
        key: Option<String>,
        cursor: Option<EventId>,
    ) -> Result<SubscribeEffect, SubscribeError> {
        if topics.is_empty() || topics.len() > self.config.max_topics_per_connection {
            return Err(SubscribeError::TopicCount);
        }
        for topic in &topics {
            validate_topic(topic).map_err(SubscribeError::Topic)?;
        }
        if self.registry.len() >= self.config.max_connections {
            return Err(SubscribeError::MaxConnections);
        }
        if let Some(k) = &key {
            if self.registry.count_for_key(k) >= self.config.max_connections_per_key {
                return Err(SubscribeError::MaxConnectionsPerKey);
            }
        }

        let id = self.registry.add(topics, key);
        let subscribed = self
            .registry
            .topics_of(id)
            .expect("just registered")
            .to_vec();

        let (checkpoint, replay) = match cursor {
            None => (Checkpoint::Absent, Vec::new()),
            Some(c) => {
                // "Was anything dropped that this cursor had not already seen?" — the
                // question §7.1 actually asks. See `History::last_trimmed` for why the
                // oldest retained entry is the wrong thing to compare against. A cursor
                // equal to the evicted id is NOT a gap: that is the event the client
                // already holds, and everything after it is still here.
                let truncated = self.history.last_trimmed().is_some_and(|t| c < t);
                let frames: Vec<Vec<u8>> =
                    self.history.since(c, &subscribed).map(|e| e.frame.clone()).collect();
                (if truncated { Checkpoint::Earliest } else { Checkpoint::Echo(c) }, frames)
            }
        };

        Ok(SubscribeEffect { id, checkpoint, replay })
    }

    /// §8.2 — the binding reports the socket's current queued depth; the hub decides.
    ///
    /// Absolute depth rather than deltas, because the socket is the only thing that
    /// knows what is truly outstanding, and add/subtract accounting drifts the first
    /// time a write is partially flushed.
    pub fn note_buffer(&mut self, id: SubscriberId, queued_bytes: usize) -> BufferVerdict {
        match self.registry.set_queued(id, queued_bytes) {
            None => BufferVerdict::Unknown,
            Some(bytes) if bytes > self.config.max_buffer_bytes => BufferVerdict::SlowConsumer,
            Some(_) => BufferVerdict::Ok,
        }
    }

    /// Builds the `~gap` frame for a subscriber being dropped as a slow consumer.
    pub fn slow_consumer_frame(&self, id: SubscriberId) -> Vec<u8> {
        let topics = self.registry.topics_of(id).unwrap_or(&[]);
        let list = topics
            .iter()
            .map(|t| json_string(t))
            .collect::<Vec<_>>()
            .join(",");
        encode_control("gap", &format!(r#"{{"reason":"slow-consumer","topics":[{list}]}}"#))
    }

    /// Builds the `~gap` frame for a cursor that history no longer reaches.
    pub fn truncated_frame(&self, id: SubscriberId) -> Vec<u8> {
        let topics = self.registry.topics_of(id).unwrap_or(&[]);
        let list = topics.iter().map(|t| json_string(t)).collect::<Vec<_>>().join(",");
        encode_control("gap", &format!(r#"{{"reason":"history-truncated","topics":[{list}]}}"#))
    }

    /// Builds the `~denied` frame naming topics `authorize` refused.
    pub fn denied_frame(&self, topics: &[String]) -> Vec<u8> {
        let list = topics.iter().map(|t| json_string(t)).collect::<Vec<_>>().join(",");
        encode_control("denied", &format!(r#"{{"topics":[{list}]}}"#))
    }

    /// Removes a subscriber. Idempotent.
    pub fn remove(&mut self, id: SubscriberId) -> bool {
        self.registry.remove(id)
    }

    /// Open subscribers.
    pub fn connection_count(&self) -> usize {
        self.registry.len()
    }

    /// Distinct subscribed topics. Diagnostics only.
    pub fn topic_count(&self) -> usize {
        self.registry.topic_count()
    }

    /// Retained history entries.
    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    /// Retained history bytes.
    pub fn history_bytes(&self) -> usize {
        self.history.bytes()
    }
}

/// Minimal JSON string escaping, so the core needs no serialisation dependency.
///
/// Topics are already validated to contain no control characters (§3), so only the two
/// structural characters can occur.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
