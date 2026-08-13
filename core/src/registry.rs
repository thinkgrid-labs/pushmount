//! Subscriber bookkeeping — §4.5, §8.2, §9.3, §10.

use std::collections::{HashMap, HashSet};

/// Opaque subscriber handle. Never reused, even after removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SubscriberId(pub u64);

pub(crate) struct Subscriber {
    pub(crate) topics: Vec<String>,
    pub(crate) key: Option<String>,
    pub(crate) queued: usize,
}

pub(crate) struct Registry {
    next: u64,
    subs: HashMap<SubscriberId, Subscriber>,
    /// §4.5 — topic index, so a publish costs O(matching) not O(subscribers).
    by_topic: HashMap<String, HashSet<SubscriberId>>,
    by_key: HashMap<String, usize>,
}

impl Registry {
    pub(crate) fn new() -> Registry {
        Registry {
            // Starts at 1 so that 0 can mean "none" across the C ABI.
            next: 1,
            subs: HashMap::new(),
            by_topic: HashMap::new(),
            by_key: HashMap::new(),
        }
    }

    pub(crate) fn count_for_key(&self, key: &str) -> usize {
        self.by_key.get(key).copied().unwrap_or(0)
    }

    pub(crate) fn add(&mut self, topics: Vec<String>, key: Option<String>) -> SubscriberId {
        // A recycled id lets a write scheduled for a closed subscriber land on whoever
        // inherited the number — a cross-tenant leak that would be near-impossible to
        // reproduce. So ids only ever move forward.
        let id = SubscriberId(self.next);
        self.next += 1;

        // Duplicates would otherwise deliver an event twice to one socket, with
        // identical ids, which no client-side dedupe can repair.
        let mut unique: Vec<String> = Vec::with_capacity(topics.len());
        for topic in topics {
            if !unique.contains(&topic) {
                unique.push(topic);
            }
        }

        for topic in &unique {
            self.by_topic.entry(topic.clone()).or_default().insert(id);
        }
        if let Some(k) = &key {
            *self.by_key.entry(k.clone()).or_insert(0) += 1;
        }
        self.subs.insert(id, Subscriber { topics: unique, key, queued: 0 });
        id
    }

    /// Idempotent — §8.2 requires removal on both the request's and the response's
    /// close event, and both fire in the ordinary case.
    pub(crate) fn remove(&mut self, id: SubscriberId) -> bool {
        let Some(sub) = self.subs.remove(&id) else { return false };

        for topic in &sub.topics {
            if let Some(set) = self.by_topic.get_mut(topic) {
                set.remove(&id);
                // Without this the index grows forever on per-entity topics, and
                // nothing user-visible ever fails.
                if set.is_empty() {
                    self.by_topic.remove(topic);
                }
            }
        }
        if let Some(k) = sub.key {
            match self.by_key.get_mut(&k) {
                Some(n) if *n > 1 => *n -= 1,
                _ => {
                    self.by_key.remove(&k);
                }
            }
        }
        true
    }

    pub(crate) fn matching(&self, topic: &str, out: &mut Vec<SubscriberId>) {
        out.clear();
        if let Some(set) = self.by_topic.get(topic) {
            out.extend(set.iter().copied());
            // Deterministic order so bindings and tests see stable fan-out.
            out.sort_unstable();
        }
    }

    pub(crate) fn set_queued(&mut self, id: SubscriberId, bytes: usize) -> Option<usize> {
        let sub = self.subs.get_mut(&id)?;
        sub.queued = bytes;
        Some(bytes)
    }

    pub(crate) fn topics_of(&self, id: SubscriberId) -> Option<&[String]> {
        self.subs.get(&id).map(|s| s.topics.as_slice())
    }

    pub(crate) fn len(&self) -> usize {
        self.subs.len()
    }

    pub(crate) fn topic_count(&self) -> usize {
        self.by_topic.len()
    }
}
