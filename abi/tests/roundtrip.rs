//! Drives the ABI exactly as a C caller would: raw pointers, manual frees, no Rust
//! conveniences.
//!
//! Run normally this checks behaviour. Run under Miri — `cargo +nightly miri test -p
//! pushmount-abi` — it also checks the unsafe for undefined behaviour: out-of-bounds
//! reads, use-after-free, invalid aliasing, uninitialised memory. That is the actual
//! answer to "how do you know the unsafe is right", and it is why these tests allocate
//! and free rather than leaking on purpose.

use pushmount::*;

/// An absent origin — §6.0's optional field, expressed as a null pointer.
fn none() -> pm_str {
    pm_str { ptr: std::ptr::null(), len: 0 }
}

fn s(text: &str) -> pm_str {
    pm_str { ptr: text.as_ptr(), len: text.len() }
}

/// Reads a frame out of a publish result the way a binding would.
fn frame_of(result: *const pm_publish_result) -> String {
    let mut len = 0usize;
    let ptr = pm_publish_frame(result, &mut len);
    assert!(!ptr.is_null());
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn version_is_exposed() {
    assert_eq!(pm_abi_version(), PM_ABI_VERSION);
}

#[test]
fn publish_produces_a_frame_and_is_freed_cleanly() {
    let hub = pm_hub_new(std::ptr::null());
    assert!(!hub.is_null());

    let mut result: *mut pm_publish_result = std::ptr::null_mut();
    let code = pm_publish(hub, 1755083412346, s("org/42/orders"), s(r#"{"id":"ord_918"}"#), none(), &mut result);
    assert_eq!(code, PM_OK);
    assert!(!result.is_null());

    assert_eq!(
        frame_of(result),
        "id: 1755083412346-0\nevent: org/42/orders\ndata: {\"id\":\"ord_918\"}\n\n"
    );

    let (mut ms, mut seq) = (0u64, 0u64);
    pm_publish_id(result, &mut ms, &mut seq);
    assert_eq!((ms, seq), (1755083412346, 0));

    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn a_payload_containing_a_blank_line_cannot_inject() {
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();
    assert_eq!(
        pm_publish(hub, 1, s("chat"), s("hello\n\nevent: ~gap\ndata: forged"), none(), &mut result),
        PM_OK
    );
    let frame = frame_of(result);
    for line in frame.lines().skip(2).filter(|l| !l.is_empty()) {
        assert!(line.starts_with("data: "), "injected line: {line}");
    }
    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn a_payload_may_contain_nul() {
    // Rule 2 in the module docs: nothing is assumed null-terminated. A `strlen` here
    // would truncate the payload at the NUL and silently deliver half the data.
    let hub = pm_hub_new(std::ptr::null());
    let payload = "before\u{0}after";
    let mut result: *mut pm_publish_result = std::ptr::null_mut();
    assert_eq!(pm_publish(hub, 1, s("t"), s(payload), none(), &mut result), PM_OK);
    assert!(frame_of(result).contains("before\u{0}after"));
    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn topic_errors_map_to_distinct_codes() {
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();

    let cases = [
        ("", PM_ERR_TOPIC_EMPTY),
        ("~gap", PM_ERR_TOPIC_RESERVED),
        ("a\nb", PM_ERR_TOPIC_CONTROL),
    ];
    for (topic, expected) in cases {
        assert_eq!(pm_publish(hub, 1, s(topic), s("x"), none(), &mut result), expected, "topic {topic:?}");
    }
    let long = "x".repeat(256);
    assert_eq!(pm_publish(hub, 1, s(&long), s("x"), none(), &mut result), PM_ERR_TOPIC_TOO_LONG);

    pm_hub_free(hub);
}

#[test]
fn subscribe_matches_publish_and_replays_from_a_cursor() {
    let hub = pm_hub_new(std::ptr::null());

    // Three events, remembering the first id as a cursor.
    let mut first_ms = 0u64;
    let mut first_seq = 0u64;
    for (i, body) in ["one", "two", "three"].iter().enumerate() {
        let mut r: *mut pm_publish_result = std::ptr::null_mut();
        assert_eq!(pm_publish(hub, 1000 + i as u64, s("t"), s(body), none(), &mut r), PM_OK);
        if i == 0 {
            pm_publish_id(r, &mut first_ms, &mut first_seq);
        }
        pm_publish_result_free(r);
    }

    let topics = [s("t")];
    let mut sub: *mut pm_subscribe_result = std::ptr::null_mut();
    let code = pm_subscribe(hub, topics.as_ptr(), topics.len(), s(""), 1, first_ms, first_seq, &mut sub);
    assert_eq!(code, PM_OK);
    assert_eq!(pm_subscribe_checkpoint(sub), PM_CHECKPOINT_ECHO);
    assert_ne!(pm_subscribe_id(sub), 0);

    // The cursor event itself is not replayed.
    assert_eq!(pm_subscribe_replay_count(sub), 2);
    let mut len = 0usize;
    let ptr = pm_subscribe_replay_at(sub, 0, &mut len);
    let first = unsafe { std::slice::from_raw_parts(ptr, len) };
    assert!(String::from_utf8_lossy(first).contains("data: two"));

    // Out-of-range index is null rather than undefined behaviour.
    assert!(pm_subscribe_replay_at(sub, 99, &mut len).is_null());

    let sub_id = pm_subscribe_id(sub);
    pm_subscribe_result_free(sub);

    // A later publish targets the subscriber.
    let mut r: *mut pm_publish_result = std::ptr::null_mut();
    assert_eq!(pm_publish(hub, 2000, s("t"), s("four"), none(), &mut r), PM_OK);
    let mut count = 0usize;
    let targets = pm_publish_targets(r, &mut count);
    assert_eq!(count, 1);
    assert_eq!(unsafe { *targets }, sub_id);
    pm_publish_result_free(r);

    pm_hub_free(hub);
}

#[test]
fn a_truncated_cursor_reports_earliest() {
    let cfg = pm_config { max_history_bytes: 400, ..Default::default() };
    let hub = pm_hub_new(&cfg);

    let mut first_ms = 0u64;
    let mut first_seq = 0u64;
    for i in 0..30u64 {
        let mut r: *mut pm_publish_result = std::ptr::null_mut();
        let body = "x".repeat(90);
        assert_eq!(pm_publish(hub, 1000 + i, s("t"), s(&body), none(), &mut r), PM_OK);
        if i == 0 {
            pm_publish_id(r, &mut first_ms, &mut first_seq);
        }
        pm_publish_result_free(r);
    }

    let topics = [s("t")];
    let mut sub: *mut pm_subscribe_result = std::ptr::null_mut();
    assert_eq!(
        pm_subscribe(hub, topics.as_ptr(), topics.len(), s(""), 1, first_ms, first_seq, &mut sub),
        PM_OK
    );
    assert_eq!(pm_subscribe_checkpoint(sub), PM_CHECKPOINT_EARLIEST);

    let gap = pm_gap_frame(hub, pm_subscribe_id(sub), PM_GAP_HISTORY_TRUNCATED);
    assert!(!gap.is_null());
    let mut len = 0usize;
    let ptr = pm_buf_data(gap, &mut len);
    let text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, len) }).to_string();
    assert!(text.starts_with("event: ~gap\n"));
    assert!(text.contains("history-truncated"));
    assert!(!text.contains("id:"), "control frames must not advance a cursor");
    pm_buf_free(gap);

    pm_subscribe_result_free(sub);
    pm_hub_free(hub);
}

#[test]
fn connection_caps_and_removal() {
    let cfg = pm_config { max_connections: 1, ..Default::default() };
    let hub = pm_hub_new(&cfg);
    let topics = [s("t")];

    let mut a: *mut pm_subscribe_result = std::ptr::null_mut();
    assert_eq!(pm_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut a), PM_OK);
    assert_eq!(pm_connection_count(hub), 1);

    let mut b: *mut pm_subscribe_result = std::ptr::null_mut();
    assert_eq!(
        pm_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut b),
        PM_ERR_MAX_CONNECTIONS
    );

    let id = pm_subscribe_id(a);
    assert_eq!(pm_remove(hub, id), 1);
    assert_eq!(pm_remove(hub, id), 0, "removal is idempotent");
    assert_eq!(pm_connection_count(hub), 0);

    pm_subscribe_result_free(a);
    pm_hub_free(hub);
}

#[test]
fn buffer_verdicts() {
    let cfg = pm_config { max_buffer_bytes: 1000, ..Default::default() };
    let hub = pm_hub_new(&cfg);
    let topics = [s("t")];
    let mut sub: *mut pm_subscribe_result = std::ptr::null_mut();
    assert_eq!(pm_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut sub), PM_OK);
    let id = pm_subscribe_id(sub);

    assert_eq!(pm_note_buffer(hub, id, 1000), PM_BUFFER_OK, "at the limit is not over it");
    assert_eq!(pm_note_buffer(hub, id, 1001), PM_BUFFER_SLOW_CONSUMER);
    assert_eq!(pm_note_buffer(hub, id, 0), PM_BUFFER_OK, "a drained socket recovers");
    assert_eq!(pm_note_buffer(hub, 99_999, 0), PM_BUFFER_UNKNOWN);

    pm_subscribe_result_free(sub);
    pm_hub_free(hub);
}

#[test]
fn cursor_starts_at_zero_and_advances() {
    let hub = pm_hub_new(std::ptr::null());
    let (mut ms, mut seq) = (7u64, 7u64);
    assert_eq!(pm_cursor(hub, &mut ms, &mut seq), PM_OK);
    assert_eq!((ms, seq), (0, 0));

    let mut r: *mut pm_publish_result = std::ptr::null_mut();
    pm_publish(hub, 1234, s("t"), s("v"), none(), &mut r);
    pm_publish_result_free(r);

    assert_eq!(pm_cursor(hub, &mut ms, &mut seq), PM_OK);
    assert_eq!((ms, seq), (1234, 0));
    pm_hub_free(hub);
}

#[test]
fn null_arguments_are_errors_not_crashes() {
    // A binding with a bug must get a status code back, not take the host process down.
    let mut result: *mut pm_publish_result = std::ptr::null_mut();
    assert_eq!(
        pm_publish(std::ptr::null_mut(), 1, s("t"), s("x"), none(), &mut result),
        PM_ERR_NULL
    );

    let hub = pm_hub_new(std::ptr::null());
    assert_eq!(pm_publish(hub, 1, s("t"), s("x"), none(), std::ptr::null_mut()), PM_ERR_NULL);
    assert_eq!(pm_cursor(hub, std::ptr::null_mut(), std::ptr::null_mut()), PM_ERR_NULL);
    assert_eq!(pm_subscribe_id(std::ptr::null()), 0);
    assert_eq!(pm_subscribe_replay_count(std::ptr::null()), 0);

    // Frees tolerate null.
    pm_hub_free(std::ptr::null_mut());
    pm_buf_free(std::ptr::null_mut());
    pm_publish_result_free(std::ptr::null_mut());
    pm_subscribe_result_free(std::ptr::null_mut());

    pm_hub_free(hub);
}

#[test]
fn invalid_utf8_is_rejected_rather_than_reinterpreted() {
    let hub = pm_hub_new(std::ptr::null());
    let bad = [0xffu8, 0xfe];
    let topic = pm_str { ptr: bad.as_ptr(), len: bad.len() };
    let mut result: *mut pm_publish_result = std::ptr::null_mut();
    assert_eq!(pm_publish(hub, 1, topic, s("x"), none(), &mut result), PM_ERR_UTF8);
    pm_hub_free(hub);
}

#[test]
fn zeroed_config_means_defaults() {
    // A caller that memsets the struct must get a working hub, not one that refuses
    // every connection because every limit read as zero.
    let cfg = pm_config::default();
    let hub = pm_hub_new(&cfg);
    let topics = [s("t")];
    let mut sub: *mut pm_subscribe_result = std::ptr::null_mut();
    assert_eq!(pm_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut sub), PM_OK);
    pm_subscribe_result_free(sub);
    pm_hub_free(hub);
}

#[test]
fn origin_is_echoed_on_the_frame() {
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();

    assert_eq!(
        pm_publish(hub, 1, s("t"), s("v"), s("7f3a1c0e"), &mut result),
        PM_OK
    );
    assert_eq!(frame_of(result), "id: 1-0\nevent: t\norigin: 7f3a1c0e\ndata: v\n\n");
    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn an_empty_origin_means_absent_rather_than_an_error() {
    // Bindings produce empty strings where a value was missing — `?? ''` in JavaScript,
    // a header that was not sent — and both cores treat that as "no origin". Rejecting
    // it would make the ordinary case the one that throws.
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();

    assert_eq!(pm_publish(hub, 1, s("t"), s("v"), s(""), &mut result), PM_OK);
    assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn an_absent_origin_is_a_null_pointer_and_omits_the_field() {
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();

    // Byte-identical to what an implementation predating the field would emit — which
    // is what makes §6.0 additive rather than a version.
    assert_eq!(pm_publish(hub, 1, s("t"), s("v"), none(), &mut result), PM_OK);
    assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
    pm_publish_result_free(result);
    pm_hub_free(hub);
}

#[test]
fn a_rejected_origin_never_reaches_the_wire() {
    let hub = pm_hub_new(std::ptr::null());
    let mut result: *mut pm_publish_result = std::ptr::null_mut();

    // The one that matters: an LF would end the frame and forge the next one.
    assert_eq!(
        pm_publish(hub, 1, s("t"), s("v"), s("a\nid: 9-9"), &mut result),
        PM_ERR_ORIGIN_CONTROL
    );
    assert_eq!(
        pm_publish(hub, 1, s("t"), s("v"), s(&"x".repeat(65)), &mut result),
        PM_ERR_ORIGIN_TOO_LONG
    );
    // `out` is untouched on error, so nothing was allocated and nothing leaks.
    assert!(result.is_null());

    // And no id was consumed by either rejection.
    assert_eq!(pm_publish(hub, 1, s("t"), s("v"), none(), &mut result), PM_OK);
    assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
    pm_publish_result_free(result);
    pm_hub_free(hub);
}
