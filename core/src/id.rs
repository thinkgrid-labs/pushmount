//! Event ids — §2.

use std::cmp::Ordering;
use std::fmt;

/// A monotonic event id, rendered on the wire as `<ms>-<seq>`.
///
/// Compared by parsed halves, never as a string: `1755083412345-10` sorts *before*
/// `1755083412345-7` lexicographically, and a client that gets this wrong silently
/// discards live events as already-seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct EventId {
    /// Unix milliseconds.
    pub ms: u64,
    /// Counter within that millisecond.
    pub seq: u64,
}

impl EventId {
    /// The id meaning "nothing has been published yet".
    pub const ZERO: EventId = EventId { ms: 0, seq: 0 };

    /// Parses a canonical `<ms>-<seq>`.
    ///
    /// Rejects leading zeros, signs, whitespace and exponents. A malformed cursor must
    /// be a `400`, never a silent downgrade to "no cursor": a client that believes it
    /// resumed and did not would never be told.
    pub fn parse(raw: &str) -> Option<EventId> {
        let (ms, seq) = raw.split_once('-')?;
        Some(EventId { ms: canonical_u64(ms)?, seq: canonical_u64(seq)? })
    }
}

fn canonical_u64(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 20 {
        return None;
    }
    if b.len() > 1 && b[0] == b'0' {
        return None;
    }
    if !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

impl Ord for EventId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.ms.cmp(&other.ms).then(self.seq.cmp(&other.seq))
    }
}

impl PartialOrd for EventId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.ms, self.seq)
    }
}

/// Assigns ids that never go backwards, even when the wall clock does.
#[derive(Debug, Default)]
pub(crate) struct Sequence {
    last: EventId,
}

impl Sequence {
    /// §2.2 — if the clock regresses or stalls, reuse the millisecond and advance the
    /// sequence. A backwards clock must never surface as a backwards cursor.
    pub(crate) fn next(&mut self, now_ms: u64) -> EventId {
        if now_ms > self.last.ms {
            self.last = EventId { ms: now_ms, seq: 0 };
        } else {
            self.last.seq += 1;
        }
        self.last
    }

    pub(crate) fn current(&self) -> EventId {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_canonical_ids() {
        assert_eq!(EventId::parse("0-0"), Some(EventId::ZERO));
        assert_eq!(EventId::parse("1755083412345-7").unwrap().seq, 7);
        for bad in ["", "1", "-0", "1-", "01-0", "1-00", "a-b", "1e5-0", " 1-0", "1-0 ", "+1-0", "1.0-0"] {
            assert!(EventId::parse(bad).is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn orders_numerically_not_lexicographically() {
        let a = EventId { ms: 1755083412345, seq: 7 };
        let b = EventId { ms: 1755083412345, seq: 10 };
        assert!(a < b);
        assert!(b.to_string() < a.to_string(), "string order really is inverted");
    }

    #[test]
    fn never_regresses_when_the_clock_does() {
        let mut s = Sequence::default();
        let ids: Vec<String> = [1000u64, 999, 999, 1001]
            .iter()
            .map(|ms| s.next(*ms).to_string())
            .collect();
        assert_eq!(ids, ["1000-0", "1000-1", "1000-2", "1001-0"]);
    }
}
