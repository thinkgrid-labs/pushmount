//! The history ring — §10.

use crate::id::EventId;
use std::collections::VecDeque;

pub(crate) struct Entry {
    pub(crate) id: EventId,
    pub(crate) topic: String,
    pub(crate) frame: Vec<u8>,
}

/// A byte-bounded ring of recent events.
///
/// Bounded in **bytes**, not entries: N events multiplied by an arbitrary payload size
/// is not a memory bound, and the failure mode is an OOM under exactly the traffic the
/// product is for.
pub(crate) struct History {
    entries: VecDeque<Entry>,
    bytes: usize,
    max_bytes: usize,
}

impl History {
    pub(crate) fn new(max_bytes: usize) -> History {
        History { entries: VecDeque::new(), bytes: 0, max_bytes }
    }

    pub(crate) fn push(&mut self, entry: Entry) {
        self.bytes += entry.frame.len();
        self.entries.push_back(entry);
        while self.bytes > self.max_bytes {
            match self.entries.pop_front() {
                Some(dropped) => self.bytes -= dropped.frame.len(),
                None => break,
            }
        }
    }

    pub(crate) fn oldest(&self) -> Option<EventId> {
        self.entries.front().map(|e| e.id)
    }

    pub(crate) fn since<'a>(
        &'a self,
        cursor: EventId,
        topics: &'a [String],
    ) -> impl Iterator<Item = &'a Entry> + 'a {
        self.entries
            .iter()
            .filter(move |e| e.id > cursor && topics.iter().any(|t| *t == e.topic))
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
}
