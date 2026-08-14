//! The protocol core.
//!
//! Everything `PROTOCOL.md` pins down lives here, and nothing else does. No sockets, no
//! clock, no allocation policy imposed on the host: the caller supplies the current
//! time and receives bytes to write. That is what lets one implementation serve Node,
//! Python, Go and Ruby without each of them re-deriving the id rules, the injection
//! defence, or the atomicity that the checkpoint depends on — see `DECISIONS.md` D3.
//!
//! The shape is effects-based. Nothing here performs an action; every operation returns
//! a description of what the binding should do:
//!
//! ```text
//!   publish(now, topic, payload) -> PublishEffect { id, frame, targets }
//!   subscribe(topics, cursor)    -> SubscribeEffect { id, checkpoint, replay }
//!   note_buffer(id, queued)      -> BufferVerdict
//! ```
//!
//! `Hub` is deliberately *not* internally synchronised. Node is single-threaded and
//! should pay nothing for locks it cannot contend; the C ABI layer wraps it in a mutex
//! for hosts that are threaded.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod codec;
mod history;
mod hub;
mod id;
mod origin;
mod registry;
mod topic;

pub use codec::{encode_control, encode_frame};
pub use hub::{
    BufferVerdict, Checkpoint, Hub, HubConfig, PublishEffect, PublishError, SubscribeEffect,
    SubscribeError,
};
pub use id::EventId;
pub use origin::{validate_origin, OriginError, MAX_ORIGIN_BYTES};
pub use registry::SubscriberId;
pub use topic::{validate_topic, TopicError, MAX_TOPIC_BYTES};

/// The reserved first byte for control frames (`~`), per §3 and §7.
///
/// A topic may not begin with it. Without that rule, publishing to a topic named `~gap`
/// forges a data-loss notification for every connected subscriber.
pub const CONTROL_PREFIX: u8 = b'~';
