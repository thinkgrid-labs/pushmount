//! Runs the shared corpus at `../conformance/vectors.json` — the same file the
//! JavaScript runner consumes.
//!
//! A vector added once is enforced on every implementation. That property is the entire
//! reason more than one implementation of this protocol is a defensible position, so it
//! must never fork.

use aghoz_core::{
    encode_frame, validate_origin, validate_topic, Checkpoint, EventId, Hub, HubConfig,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/vectors.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read the corpus at {path}: {e}"));
    serde_json::from_str(&raw).expect("corpus is not valid JSON")
}

#[test]
fn encode_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["encode"].as_array().unwrap() {
        let id = EventId {
            ms: v["ms"].as_u64().unwrap(),
            seq: v["seq"].as_u64().unwrap(),
        };
        let got = String::from_utf8(encode_frame(
            id,
            v["topic"].as_str().unwrap(),
            v["payload"].as_str().unwrap(),
            v["origin"].as_str(),
        ))
        .unwrap();
        let want = v["frame"].as_str().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected: {want:?}\n      actual:   {got:?}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn topic_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["topic"].as_array().unwrap() {
        let got = validate_topic(v["topic"].as_str().unwrap()).is_ok();
        let want = v["valid"].as_bool().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected valid={want}, got {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn origin_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["origin"].as_array().unwrap() {
        let got = validate_origin(v["origin"].as_str().unwrap()).is_ok();
        let want = v["valid"].as_bool().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected valid={want}, got {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn id_order_vectors() {
    let c = corpus();
    for v in c["idOrder"].as_array().unwrap() {
        let a = v["a"].as_array().unwrap();
        let b = v["b"].as_array().unwrap();
        let a = EventId { ms: a[0].as_u64().unwrap(), seq: a[1].as_u64().unwrap() };
        let b = EventId { ms: b[0].as_u64().unwrap(), seq: b[1].as_u64().unwrap() };
        let got = match a.cmp(&b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        assert_eq!(
            got,
            v["cmp"].as_i64().unwrap(),
            "{}  {}",
            v["id"].as_str().unwrap(),
            v["desc"].as_str().unwrap()
        );
    }
}

/// §4.5 / §7.1 — whether a reconnecting client is told it missed events.
///
/// Runs the same corpus the JavaScript runner does. This category exists because the two
/// implementations diverging here would be invisible: both would serve a stream, and only
/// one would be honest about what it had dropped.
#[test]
fn checkpoint_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["checkpoint"].as_array().unwrap() {
        let config = HubConfig {
            max_history_bytes: v["maxHistoryBytes"].as_u64().unwrap() as usize,
            ..HubConfig::default()
        };
        let mut hub = Hub::new(config);
        for p in v["publishes"].as_array().unwrap() {
            let a = p.as_array().unwrap();
            hub.publish(
                a[0].as_u64().unwrap(),
                a[1].as_str().unwrap(),
                a[2].as_str().unwrap(),
                None,
            )
            .unwrap();
        }

        let cursor = v["cursor"].as_array().map(|a| EventId {
            ms: a[0].as_u64().unwrap(),
            seq: a[1].as_u64().unwrap(),
        });
        let effect = hub.subscribe(vec!["t".to_string()], None, cursor).unwrap();
        let got = match effect.checkpoint {
            Checkpoint::Absent => "absent",
            Checkpoint::Echo(_) => "echo",
            Checkpoint::Earliest => "earliest",
        };
        let want = v["expected"].as_str().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected: {want}\n      actual:   {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn monotonic_vectors() {
    let c = corpus();
    for v in c["monotonic"].as_array().unwrap() {
        let mut hub = Hub::new(HubConfig::default());
        let got: Vec<String> = v["nowMs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ms| hub.publish(ms.as_u64().unwrap(), "t", "x", None).unwrap().id.to_string())
            .collect();
        let want: Vec<String> = v["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            got,
            want,
            "{}  {}",
            v["id"].as_str().unwrap(),
            v["desc"].as_str().unwrap()
        );
    }
}
