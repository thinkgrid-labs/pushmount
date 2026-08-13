//! Spike B — the hot path of the hub, in Rust, compiled to wasm.
//!
//! Implements exactly the operations PROTOCOL.md makes the core responsible for, and
//! nothing else:
//!
//!   * §2   id assignment, including the monotonicity rule for clock regression
//!   * §3   topic validation
//!   * §6.1 frame encoding with payload segmentation
//!   * §10  byte-bounded history ring
//!   * §4.5 subscriber matching
//!
//! The TypeScript reference in ../ts/hub.mjs is a line-for-line equivalent. Any
//! divergence in output is a bug in the spike, not a finding.

use std::collections::VecDeque;
use wasm_bindgen::prelude::*;

const MAX_TOPIC_BYTES: usize = 255;

struct Event {
    ms: u64,
    seq: u64,
    topic: String,
    frame: Vec<u8>,
}

struct Sub {
    id: u32,
    topics: Vec<String>,
}

#[wasm_bindgen]
pub struct Hub {
    last_ms: u64,
    last_seq: u64,
    history: VecDeque<Event>,
    history_bytes: usize,
    max_history_bytes: usize,
    subs: Vec<Sub>,
    /// Reused across publishes so the hot path allocates nothing for matching.
    targets: Vec<u32>,
}

#[wasm_bindgen]
impl Hub {
    #[wasm_bindgen(constructor)]
    pub fn new(max_history_bytes: usize) -> Hub {
        Hub {
            last_ms: 0,
            last_seq: 0,
            history: VecDeque::new(),
            history_bytes: 0,
            max_history_bytes,
            subs: Vec::new(),
            targets: Vec::new(),
        }
    }

    pub fn subscribe(&mut self, id: u32, topics: String) {
        self.subs.push(Sub {
            id,
            topics: topics.split(',').map(|s| s.to_string()).collect(),
        });
    }

    /// PROTOCOL.md §3. Returns true when the topic is publishable.
    pub fn valid_topic(topic: &str) -> bool {
        let b = topic.as_bytes();
        if b.is_empty() || b.len() > MAX_TOPIC_BYTES {
            return false;
        }
        if b[0] == b'~' {
            return false;
        }
        !b.iter().any(|&c| c < 0x20 || c == 0x7f)
    }

    /// The hot path: validate, assign an id, encode, append to history, match.
    /// Returns the encoded frame; targets are read separately so the common case
    /// crosses the boundary once.
    /// `now_ms` is f64, not u64, deliberately: wasm-bindgen maps u64 to BigInt, which
    /// would force `hub.publish(BigInt(Date.now()), ...)` on every caller and cost a
    /// boxed allocation per publish. f64 represents every integer below 2^53 exactly,
    /// and Unix milliseconds do not reach that until the year 287396.
    pub fn publish(&mut self, now_ms: f64, topic: &str, payload: &str) -> Vec<u8> {
        if !Hub::valid_topic(topic) {
            return Vec::new();
        }
        let now_ms = now_ms as u64;

        // §2.2 — never assign an id <= the last one, even if the clock moves backwards.
        if now_ms > self.last_ms {
            self.last_ms = now_ms;
            self.last_seq = 0;
        } else {
            self.last_seq += 1;
        }
        let (ms, seq) = (self.last_ms, self.last_seq);

        let frame = encode_frame(ms, seq, topic, payload);

        self.targets.clear();
        for s in &self.subs {
            if s.topics.iter().any(|t| t == topic) {
                self.targets.push(s.id);
            }
        }

        self.history_bytes += frame.len();
        self.history.push_back(Event {
            ms,
            seq,
            topic: topic.to_string(),
            frame: frame.clone(),
        });
        while self.history_bytes > self.max_history_bytes {
            match self.history.pop_front() {
                Some(e) => self.history_bytes -= e.frame.len(),
                None => break,
            }
        }

        frame
    }

    pub fn target_count(&self) -> usize {
        self.targets.len()
    }

    /// §4.5 steps 1 and 3: checkpoint decision plus replay snapshot, one critical
    /// section. Returns the concatenated replay frames; `truncated` reports whether
    /// the checkpoint must be `earliest`.
    pub fn replay(&self, cursor_ms: f64, cursor_seq: f64, topics: String) -> Vec<u8> {
        let (cursor_ms, cursor_seq) = (cursor_ms as u64, cursor_seq as u64);
        let want: Vec<&str> = topics.split(',').collect();
        let mut out = Vec::new();
        for e in &self.history {
            if (e.ms, e.seq) > (cursor_ms, cursor_seq) && want.iter().any(|t| *t == e.topic) {
                out.extend_from_slice(&e.frame);
            }
        }
        out
    }

    pub fn truncated(&self, cursor_ms: f64, cursor_seq: f64) -> bool {
        match self.history.front() {
            None => false,
            Some(oldest) => (cursor_ms as u64, cursor_seq as u64) < (oldest.ms, oldest.seq),
        }
    }

    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    /// Runs the same publish loop entirely inside wasm, so nothing crosses the
    /// boundary. Separates "how fast is the Rust logic" from "what does marshalling
    /// cost" — the end-to-end numbers alone cannot tell those apart, and they imply
    /// different decisions.
    pub fn bench_internal(&mut self, ops: u32, topic: &str, payload: &str) -> usize {
        let mut now = 1755083412345f64;
        let mut total = 0usize;
        for i in 0..ops {
            if i % 64 == 0 {
                now += 1.0;
            }
            total += self.publish(now, topic, payload).len();
        }
        total
    }
}

/// §6.1 — one `data:` line per CR/LF/CRLF-delimited segment. Emitting the payload
/// raw is the injection bug conformance vector V2 exists to catch.
pub fn encode_frame_for_tests(ms: u64, seq: u64, topic: &str, payload: &str) -> Vec<u8> {
    encode_frame(ms, seq, topic, payload)
}

fn encode_frame(ms: u64, seq: u64, topic: &str, payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + topic.len() + 48);

    out.extend_from_slice(b"id: ");
    push_u64(&mut out, ms);
    out.push(b'-');
    push_u64(&mut out, seq);
    out.push(b'\n');

    out.extend_from_slice(b"event: ");
    out.extend_from_slice(topic.as_bytes());
    out.push(b'\n');

    let b = payload.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\r' || b[i] == b'\n' {
            out.extend_from_slice(b"data: ");
            out.extend_from_slice(&b[start..i]);
            out.push(b'\n');
            if b[i] == b'\r' && i + 1 < b.len() && b[i + 1] == b'\n' {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    out.extend_from_slice(b"data: ");
    out.extend_from_slice(&b[start..]);
    out.push(b'\n');
    out.push(b'\n');

    out
}

fn push_u64(out: &mut Vec<u8>, mut n: u64) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.extend_from_slice(&buf[i..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[u8]) -> String {
        String::from_utf8(v.to_vec()).unwrap()
    }

    #[test]
    fn v1_simple_event() {
        let f = encode_frame(1755083412346, 0, "org/42/orders", r#"{"id":"ord_918"}"#);
        assert_eq!(
            s(&f),
            "id: 1755083412346-0\nevent: org/42/orders\ndata: {\"id\":\"ord_918\"}\n\n"
        );
    }

    #[test]
    fn v2_payload_with_blank_line_cannot_inject() {
        let f = encode_frame(1, 0, "chat", "hello\n\nevent: ~gap\ndata: forged");
        let got = s(&f);
        assert_eq!(
            got,
            "id: 1-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n"
        );
        // Every line after the header is either a field we wrote or a data line.
        for line in got.lines().skip(2).filter(|l| !l.is_empty()) {
            assert!(line.starts_with("data: "), "injected line: {line}");
        }
    }

    #[test]
    fn v3_empty_payload() {
        assert_eq!(s(&encode_frame(1, 0, "ping", "")), "id: 1-0\nevent: ping\ndata: \n\n");
    }

    #[test]
    fn v4_id_ordering() {
        assert!((1755083412345u64, 7u64) < (1755083412345, 10));
        assert!((1755083412345u64, 10u64) < (1755083412346, 0));
        // The bug this vector exists to catch:
        assert!("1755083412345-10" < "1755083412345-7");
    }

    #[test]
    fn v5_rejected_topics() {
        for bad in ["", "a\nb", "a\rb", "a\0b", "~gap", "~"] {
            assert!(!Hub::valid_topic(bad), "should reject {bad:?}");
        }
        assert!(!Hub::valid_topic(&"x".repeat(256)));
        assert!(Hub::valid_topic(&"x".repeat(255)));
        assert!(Hub::valid_topic("org/42/orders"));
    }

    #[test]
    fn ids_never_go_backwards_when_the_clock_does() {
        let mut h = Hub::new(1 << 20);
        h.publish(1000.0, "t", "a");
        h.publish(999.0, "t", "b"); // clock regressed
        h.publish(999.0, "t", "c");
        let ids: Vec<String> = h
            .history
            .iter()
            .map(|e| format!("{}-{}", e.ms, e.seq))
            .collect();
        assert_eq!(ids, vec!["1000-0", "1000-1", "1000-2"]);
    }

    #[test]
    fn history_is_bounded_by_bytes() {
        let mut h = Hub::new(500);
        for i in 0..100 {
            h.publish(1000.0 + i as f64, "t", &"x".repeat(50));
        }
        assert!(h.history_bytes <= 500, "bytes = {}", h.history_bytes);
        assert!(h.history_len() < 100);
    }
}
