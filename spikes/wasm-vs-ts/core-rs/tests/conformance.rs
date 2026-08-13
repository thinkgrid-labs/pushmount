//! Runs the shared corpus at ../../../conformance/vectors.json.
//!
//! This is the Rust half of the gate PROTOCOL.md §12 describes. Both implementations
//! read the same file, so a vector added for one is automatically enforced on the other
//! — which is the only reason having two hub implementations is a defensible position.

use pushmount_spike::{encode_frame_for_tests as encode_frame, Hub};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../conformance/vectors.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read corpus at {path}: {e}"));
    serde_json::from_str(&raw).expect("corpus is not valid JSON")
}

#[test]
fn encode_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["encode"].as_array().unwrap() {
        let got = String::from_utf8(encode_frame(
            v["ms"].as_u64().unwrap(),
            v["seq"].as_u64().unwrap(),
            v["topic"].as_str().unwrap(),
            v["payload"].as_str().unwrap(),
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
        let topic = v["topic"].as_str().unwrap();
        let got = Hub::valid_topic(topic);
        let want = v["valid"].as_bool().unwrap();
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
fn id_order_vectors() {
    let c = corpus();
    for v in c["idOrder"].as_array().unwrap() {
        let a = v["a"].as_array().unwrap();
        let b = v["b"].as_array().unwrap();
        let a = (a[0].as_u64().unwrap(), a[1].as_u64().unwrap());
        let b = (b[0].as_u64().unwrap(), b[1].as_u64().unwrap());
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

#[test]
fn monotonic_vectors() {
    let c = corpus();
    for v in c["monotonic"].as_array().unwrap() {
        let mut hub = Hub::new(8 * 1024 * 1024);
        let got: Vec<String> = v["nowMs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ms| {
                let frame = hub.publish(ms.as_f64().unwrap(), "t", "x");
                let s = String::from_utf8(frame).unwrap();
                s["id: ".len()..s.find('\n').unwrap()].to_string()
            })
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
