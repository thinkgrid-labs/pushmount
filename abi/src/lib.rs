//! The stable C ABI over [`pushmount_core`].
//!
//! Every language binding targets this surface — napi for Node, PyO3 or ctypes for
//! Python, cgo for Go, FFI for Ruby. It is the expensive thing to change, so it is
//! deliberately small: a handle, three operations, and accessors for what they return.
//!
//! Three rules hold everywhere in this file, and breaking any of them is a soundness
//! bug rather than a style question:
//!
//! 1. **No panic crosses the boundary.** Unwinding into C is undefined behaviour, so
//!    every entry point is wrapped in [`std::panic::catch_unwind`] and turns a panic
//!    into [`PM_ERR_PANIC`].
//! 2. **Nothing is assumed null-terminated.** Every string is a pointer and a length.
//!    Payloads may legitimately contain NUL — §3 forbids it in *topics*, not in data —
//!    and a `strlen` here would silently truncate user content.
//! 3. **Rust allocations are freed by Rust.** Anything handed out has a matching
//!    `*_free`; callers must never `free()` it themselves.
//!
//! `pushmount-core` is `forbid(unsafe_code)` and stays that way. **All of the unsafe in
//! the project lives here, in one auditable file**, and it is all one of three shapes:
//! turn a caller's pointer+length into a slice, read through a pointer the caller
//! promised is valid, or write a result through an out-pointer.
//!
//! A C ABI cannot be written without unsafe — dereferencing a caller-supplied pointer
//! is unsafe by definition, and that is the entire content of an FFI boundary. What can
//! be done is to make it small, uniform, and verified: `unsafe_op_in_unsafe_fn` is
//! denied below so no operation hides inside an `unsafe fn` signature, and CI runs the
//! ABI test suite under Miri, which actually executes these paths looking for undefined
//! behaviour rather than trusting review.

// These names appear verbatim in `include/pushmount.h` and in every binding's
// declarations. Renaming them to Rust convention would make the two disagree.
#![allow(non_camel_case_types)]
// An `unsafe fn` does not implicitly make its body an unsafe block: every dereference
// must be spelled out, so none of them can be added later without review noticing.
#![deny(unsafe_op_in_unsafe_fn)]

use pushmount_core::{
    BufferVerdict, Checkpoint, EventId, Hub, HubConfig, PublishEffect, SubscribeEffect,
    SubscribeError, SubscriberId, TopicError,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

// ---------------------------------------------------------------- status codes

/// Success.
pub const PM_OK: i32 = 0;
/// A topic was empty.
pub const PM_ERR_TOPIC_EMPTY: i32 = -1;
/// A topic exceeded 255 bytes. Bytes, not characters.
pub const PM_ERR_TOPIC_TOO_LONG: i32 = -2;
/// A topic contained a C0 control character or DEL.
pub const PM_ERR_TOPIC_CONTROL: i32 = -3;
/// A topic began with the reserved `~`.
pub const PM_ERR_TOPIC_RESERVED: i32 = -4;
/// Zero topics, or more than the configured maximum.
pub const PM_ERR_TOPIC_COUNT: i32 = -5;
/// The per-process connection cap was reached. Bindings map this to `429`.
pub const PM_ERR_MAX_CONNECTIONS: i32 = -6;
/// The per-key connection cap was reached. `429`.
pub const PM_ERR_MAX_CONNECTIONS_PER_KEY: i32 = -7;
/// A required pointer was null.
pub const PM_ERR_NULL: i32 = -8;
/// A string argument was not valid UTF-8.
pub const PM_ERR_UTF8: i32 = -9;
/// A panic was caught at the boundary. Indicates a bug in the core.
pub const PM_ERR_PANIC: i32 = -10;
/// The hub's lock was poisoned by an earlier panic; the hub is no longer usable.
pub const PM_ERR_POISONED: i32 = -11;

/// Subscriber is keeping up.
pub const PM_BUFFER_OK: i32 = 0;
/// Subscriber is past `max_buffer_bytes`; write the gap frame, then close.
pub const PM_BUFFER_SLOW_CONSUMER: i32 = 1;
/// No such subscriber — a write that completed after teardown.
pub const PM_BUFFER_UNKNOWN: i32 = 2;

/// No cursor was presented; omit the checkpoint header entirely.
pub const PM_CHECKPOINT_ABSENT: i32 = 0;
/// History reaches the cursor; echo it back.
pub const PM_CHECKPOINT_ECHO: i32 = 1;
/// History no longer reaches it; send `earliest` and a `~gap` frame.
pub const PM_CHECKPOINT_EARLIEST: i32 = 2;

/// `~gap` reason: the cursor was older than retained history.
pub const PM_GAP_HISTORY_TRUNCATED: i32 = 0;
/// `~gap` reason: the subscriber could not drain its socket.
pub const PM_GAP_SLOW_CONSUMER: i32 = 1;

/// The ABI revision. Bindings should refuse to load a library whose major differs.
///
/// Encoded as `major * 1000 + minor`.
pub const PM_ABI_VERSION: u32 = 1_000;

// ---------------------------------------------------------------------- types

/// A borrowed byte string: pointer and length, never assumed null-terminated.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct pm_str {
    /// Start of the bytes. May be null only when `len` is zero.
    pub ptr: *const u8,
    /// Length in bytes.
    pub len: usize,
}

impl pm_str {
    /// # Safety
    /// `ptr` must be valid for `len` bytes, or `len` must be zero.
    unsafe fn as_str(&self) -> Result<&str, i32> {
        if self.len == 0 {
            return Ok("");
        }
        if self.ptr.is_null() {
            return Err(PM_ERR_NULL);
        }
        let bytes = unsafe { std::slice::from_raw_parts(self.ptr, self.len) };
        std::str::from_utf8(bytes).map_err(|_| PM_ERR_UTF8)
    }
}

/// Limits. Zero means "use the default" for every field, so a caller that
/// zero-initialises the struct gets sane behaviour rather than a hub that refuses
/// every connection.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct pm_config {
    /// Bytes of history retained. 0 → 8 MiB.
    pub max_history_bytes: u64,
    /// Queued bytes before a subscriber is a slow consumer. 0 → 1 MiB.
    pub max_buffer_bytes: u64,
    /// Connections per process. 0 → unlimited.
    pub max_connections: u64,
    /// Connections per key. 0 → unlimited.
    pub max_connections_per_key: u64,
    /// Topics per connection. 0 → 64.
    pub max_topics_per_connection: u64,
}

impl From<pm_config> for HubConfig {
    fn from(c: pm_config) -> HubConfig {
        let d = HubConfig::default();
        HubConfig {
            max_history_bytes: pick(c.max_history_bytes, d.max_history_bytes),
            max_buffer_bytes: pick(c.max_buffer_bytes, d.max_buffer_bytes),
            max_connections: pick_unlimited(c.max_connections),
            max_connections_per_key: pick_unlimited(c.max_connections_per_key),
            max_topics_per_connection: pick(c.max_topics_per_connection, d.max_topics_per_connection),
        }
    }
}

fn pick(v: u64, default: usize) -> usize {
    if v == 0 {
        default
    } else {
        v as usize
    }
}

fn pick_unlimited(v: u64) -> usize {
    if v == 0 {
        usize::MAX
    } else {
        v as usize
    }
}

/// An opaque hub handle.
///
/// Internally synchronised, because Go, the JVM and threaded Python may call from
/// several threads. Node pays for an uncontended lock, which is far cheaper than the
/// alternative of a second, unsynchronised entry point to keep correct.
pub struct pm_hub {
    inner: Mutex<Hub>,
}

/// The result of a publish. Owns the encoded frame and the target list.
pub struct pm_publish_result {
    effect: PublishEffect,
    targets: Vec<u64>,
}

/// The result of a subscribe. Owns the replay frames.
pub struct pm_subscribe_result {
    effect: SubscribeEffect,
}

/// An owned byte buffer handed to the caller. Free with [`pm_buf_free`].
pub struct pm_buf {
    bytes: Vec<u8>,
}

// ------------------------------------------------------------------- helpers

fn topic_code(e: TopicError) -> i32 {
    match e {
        TopicError::Empty => PM_ERR_TOPIC_EMPTY,
        TopicError::TooLong => PM_ERR_TOPIC_TOO_LONG,
        TopicError::ControlCharacter => PM_ERR_TOPIC_CONTROL,
        TopicError::ReservedPrefix => PM_ERR_TOPIC_RESERVED,
    }
}

fn subscribe_code(e: SubscribeError) -> i32 {
    match e {
        SubscribeError::Topic(t) => topic_code(t),
        SubscribeError::TopicCount => PM_ERR_TOPIC_COUNT,
        SubscribeError::MaxConnections => PM_ERR_MAX_CONNECTIONS,
        SubscribeError::MaxConnectionsPerKey => PM_ERR_MAX_CONNECTIONS_PER_KEY,
    }
}

/// Runs `f` with the hub locked, converting panics and poisoning into status codes.
fn with_hub<F>(hub: *mut pm_hub, f: F) -> i32
where
    F: FnOnce(&mut Hub) -> i32,
{
    if hub.is_null() {
        return PM_ERR_NULL;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let handle = unsafe { &*hub };
        match handle.inner.lock() {
            Err(_) => PM_ERR_POISONED,
            Ok(mut guard) => f(&mut guard),
        }
    }));
    result.unwrap_or(PM_ERR_PANIC)
}

// ------------------------------------------------------------------ lifecycle

/// Returns [`PM_ABI_VERSION`].
#[no_mangle]
pub extern "C" fn pm_abi_version() -> u32 {
    PM_ABI_VERSION
}

/// Creates a hub. `config` may be null, meaning all defaults.
///
/// Returns null only on allocation failure or panic.
#[no_mangle]
pub extern "C" fn pm_hub_new(config: *const pm_config) -> *mut pm_hub {
    let result = catch_unwind(|| {
        let cfg = if config.is_null() {
            pm_config::default()
        } else {
            unsafe { *config }
        };
        Box::into_raw(Box::new(pm_hub {
            inner: Mutex::new(Hub::new(cfg.into())),
        }))
    });
    result.unwrap_or(std::ptr::null_mut())
}

/// Destroys a hub. Null is a no-op. Must not be called twice on the same pointer.
#[no_mangle]
pub extern "C" fn pm_hub_free(hub: *mut pm_hub) {
    if hub.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(hub));
    }));
}

// -------------------------------------------------------------------- publish

/// Assigns an id, encodes a frame, and matches subscribers.
///
/// On [`PM_OK`], `*out` receives a result the caller must release with
/// [`pm_publish_result_free`]. On error, `*out` is left untouched.
#[no_mangle]
pub extern "C" fn pm_publish(
    hub: *mut pm_hub,
    now_ms: u64,
    topic: pm_str,
    payload: pm_str,
    out: *mut *mut pm_publish_result,
) -> i32 {
    if out.is_null() {
        return PM_ERR_NULL;
    }
    with_hub(hub, |h| {
        let topic = match unsafe { topic.as_str() } {
            Ok(t) => t,
            Err(code) => return code,
        };
        let payload = match unsafe { payload.as_str() } {
            Ok(p) => p,
            Err(code) => return code,
        };
        match h.publish(now_ms, topic, payload) {
            Err(e) => topic_code(e),
            Ok(effect) => {
                let targets = effect.targets.iter().map(|s| s.0).collect();
                let boxed = Box::new(pm_publish_result { effect, targets });
                unsafe { *out = Box::into_raw(boxed) };
                PM_OK
            }
        }
    })
}

/// The encoded frame. Valid until the result is freed.
#[no_mangle]
pub extern "C" fn pm_publish_frame(result: *const pm_publish_result, len: *mut usize) -> *const u8 {
    if result.is_null() || len.is_null() {
        return std::ptr::null();
    }
    let r = unsafe { &*result };
    unsafe { *len = r.effect.frame.len() };
    r.effect.frame.as_ptr()
}

/// The matching subscriber ids. Valid until the result is freed.
#[no_mangle]
pub extern "C" fn pm_publish_targets(
    result: *const pm_publish_result,
    count: *mut usize,
) -> *const u64 {
    if result.is_null() || count.is_null() {
        return std::ptr::null();
    }
    let r = unsafe { &*result };
    unsafe { *count = r.targets.len() };
    r.targets.as_ptr()
}

/// Writes the assigned id into `ms` and `seq`.
#[no_mangle]
pub extern "C" fn pm_publish_id(result: *const pm_publish_result, ms: *mut u64, seq: *mut u64) {
    if result.is_null() || ms.is_null() || seq.is_null() {
        return;
    }
    let r = unsafe { &*result };
    unsafe {
        *ms = r.effect.id.ms;
        *seq = r.effect.id.seq;
    }
}

/// Releases a publish result. Null is a no-op.
#[no_mangle]
pub extern "C" fn pm_publish_result_free(result: *mut pm_publish_result) {
    if result.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(result));
    }));
}

// ------------------------------------------------------------------ subscribe

/// Registers a subscriber, decides the checkpoint and snapshots the replay set.
///
/// These are one call because §4.5 requires them to describe one instant. A binding
/// that split them across two FFI calls would reintroduce exactly the race the single
/// call exists to prevent, so the ABI does not offer the pieces separately.
///
/// `key` may be empty to opt out of the per-key cap. `has_cursor` is 0 or 1.
#[no_mangle]
pub extern "C" fn pm_subscribe(
    hub: *mut pm_hub,
    topics: *const pm_str,
    topic_count: usize,
    key: pm_str,
    has_cursor: i32,
    cursor_ms: u64,
    cursor_seq: u64,
    out: *mut *mut pm_subscribe_result,
) -> i32 {
    if out.is_null() || (topics.is_null() && topic_count > 0) {
        return PM_ERR_NULL;
    }
    with_hub(hub, |h| {
        let slice = if topic_count == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(topics, topic_count) }
        };
        let mut owned = Vec::with_capacity(slice.len());
        for entry in slice {
            match unsafe { entry.as_str() } {
                Ok(t) => owned.push(t.to_string()),
                Err(code) => return code,
            }
        }
        let key = match unsafe { key.as_str() } {
            Ok(k) if k.is_empty() => None,
            Ok(k) => Some(k.to_string()),
            Err(code) => return code,
        };
        let cursor = if has_cursor != 0 {
            Some(EventId { ms: cursor_ms, seq: cursor_seq })
        } else {
            None
        };

        match h.subscribe(owned, key, cursor) {
            Err(e) => subscribe_code(e),
            Ok(effect) => {
                unsafe { *out = Box::into_raw(Box::new(pm_subscribe_result { effect })) };
                PM_OK
            }
        }
    })
}

/// The registered subscriber id. Never zero on success.
#[no_mangle]
pub extern "C" fn pm_subscribe_id(result: *const pm_subscribe_result) -> u64 {
    if result.is_null() {
        return 0;
    }
    unsafe { &*result }.effect.id.0
}

/// One of the `PM_CHECKPOINT_*` constants.
#[no_mangle]
pub extern "C" fn pm_subscribe_checkpoint(result: *const pm_subscribe_result) -> i32 {
    if result.is_null() {
        return PM_CHECKPOINT_ABSENT;
    }
    match unsafe { &*result }.effect.checkpoint {
        Checkpoint::Absent => PM_CHECKPOINT_ABSENT,
        Checkpoint::Echo(_) => PM_CHECKPOINT_ECHO,
        Checkpoint::Earliest => PM_CHECKPOINT_EARLIEST,
    }
}

/// How many frames to replay.
#[no_mangle]
pub extern "C" fn pm_subscribe_replay_count(result: *const pm_subscribe_result) -> usize {
    if result.is_null() {
        return 0;
    }
    unsafe { &*result }.effect.replay.len()
}

/// The `index`th replay frame, oldest first. Valid until the result is freed.
#[no_mangle]
pub extern "C" fn pm_subscribe_replay_at(
    result: *const pm_subscribe_result,
    index: usize,
    len: *mut usize,
) -> *const u8 {
    if result.is_null() || len.is_null() {
        return std::ptr::null();
    }
    let r = unsafe { &*result };
    match r.effect.replay.get(index) {
        None => std::ptr::null(),
        Some(frame) => {
            unsafe { *len = frame.len() };
            frame.as_ptr()
        }
    }
}

/// Releases a subscribe result. Null is a no-op.
#[no_mangle]
pub extern "C" fn pm_subscribe_result_free(result: *mut pm_subscribe_result) {
    if result.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(result));
    }));
}

// ------------------------------------------------------------- subscriber ops

/// Reports a subscriber's queued byte depth. Returns a `PM_BUFFER_*` constant.
///
/// Absolute depth, not a delta: the socket is the only thing that knows what is truly
/// outstanding, and add/subtract accounting drifts the first time a write is partially
/// flushed.
#[no_mangle]
pub extern "C" fn pm_note_buffer(hub: *mut pm_hub, subscriber: u64, queued_bytes: u64) -> i32 {
    let code = with_hub(hub, |h| {
        match h.note_buffer(SubscriberId(subscriber), queued_bytes as usize) {
            BufferVerdict::Ok => PM_BUFFER_OK,
            BufferVerdict::SlowConsumer => PM_BUFFER_SLOW_CONSUMER,
            BufferVerdict::Unknown => PM_BUFFER_UNKNOWN,
        }
    });
    code
}

/// Removes a subscriber. Idempotent — returns 1 if it existed, 0 if not.
#[no_mangle]
pub extern "C" fn pm_remove(hub: *mut pm_hub, subscriber: u64) -> i32 {
    with_hub(hub, |h| i32::from(h.remove(SubscriberId(subscriber))))
}

/// Open subscriber count, or a negative status code.
#[no_mangle]
pub extern "C" fn pm_connection_count(hub: *mut pm_hub) -> i64 {
    let mut count: i64 = 0;
    let code = with_hub(hub, |h| {
        count = h.connection_count() as i64;
        PM_OK
    });
    if code == PM_OK {
        count
    } else {
        code as i64
    }
}

/// Writes the newest assigned id, or `0-0` if nothing has been published.
#[no_mangle]
pub extern "C" fn pm_cursor(hub: *mut pm_hub, ms: *mut u64, seq: *mut u64) -> i32 {
    if ms.is_null() || seq.is_null() {
        return PM_ERR_NULL;
    }
    with_hub(hub, |h| {
        let c = h.cursor();
        unsafe {
            *ms = c.ms;
            *seq = c.seq;
        }
        PM_OK
    })
}

// --------------------------------------------------------------- control frames

/// Builds a `~gap` frame for a subscriber. `reason` is a `PM_GAP_*` constant.
///
/// Returns null on error. Free with [`pm_buf_free`].
#[no_mangle]
pub extern "C" fn pm_gap_frame(hub: *mut pm_hub, subscriber: u64, reason: i32) -> *mut pm_buf {
    let mut out: *mut pm_buf = std::ptr::null_mut();
    let _ = with_hub(hub, |h| {
        let id = SubscriberId(subscriber);
        let bytes = if reason == PM_GAP_SLOW_CONSUMER {
            h.slow_consumer_frame(id)
        } else {
            h.truncated_frame(id)
        };
        out = Box::into_raw(Box::new(pm_buf { bytes }));
        PM_OK
    });
    out
}

/// Builds a `~denied` frame naming the topics `authorize` refused.
#[no_mangle]
pub extern "C" fn pm_denied_frame(
    hub: *mut pm_hub,
    topics: *const pm_str,
    topic_count: usize,
) -> *mut pm_buf {
    if topics.is_null() && topic_count > 0 {
        return std::ptr::null_mut();
    }
    let mut out: *mut pm_buf = std::ptr::null_mut();
    let _ = with_hub(hub, |h| {
        let slice = if topic_count == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(topics, topic_count) }
        };
        let mut owned = Vec::with_capacity(slice.len());
        for entry in slice {
            match unsafe { entry.as_str() } {
                Ok(t) => owned.push(t.to_string()),
                Err(code) => return code,
            }
        }
        out = Box::into_raw(Box::new(pm_buf { bytes: h.denied_frame(&owned) }));
        PM_OK
    });
    out
}

/// The bytes of an owned buffer.
#[no_mangle]
pub extern "C" fn pm_buf_data(buf: *const pm_buf, len: *mut usize) -> *const u8 {
    if buf.is_null() || len.is_null() {
        return std::ptr::null();
    }
    let b = unsafe { &*buf };
    unsafe { *len = b.bytes.len() };
    b.bytes.as_ptr()
}

/// Releases an owned buffer. Null is a no-op.
#[no_mangle]
pub extern "C" fn pm_buf_free(buf: *mut pm_buf) {
    if buf.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(buf));
    }));
}
