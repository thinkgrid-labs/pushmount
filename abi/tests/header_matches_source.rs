//! The header and the source must agree.
//!
//! `aghoz.h` is hand-written rather than generated, because the comments in it are
//! worth more to a binding author than anything a generator produces. The cost of that
//! choice is drift, so this test pays it back: every exported symbol must be declared,
//! and every declaration must exist.

const SOURCE: &str = include_str!("../src/lib.rs");
const HEADER: &str = include_str!("../include/aghoz.h");

/// Symbols the source exports via `#[no_mangle] pub extern "C"`.
fn exported() -> Vec<String> {
    let mut names = Vec::new();
    let mut previous_was_no_mangle = false;
    for line in SOURCE.lines() {
        let trimmed = line.trim();
        if trimmed == "#[no_mangle]" {
            previous_was_no_mangle = true;
            continue;
        }
        if previous_was_no_mangle {
            if let Some(rest) = trimmed.strip_prefix("pub extern \"C\" fn ") {
                if let Some(name) = rest.split('(').next() {
                    names.push(name.to_string());
                }
            }
            previous_was_no_mangle = false;
        }
    }
    names
}

#[test]
fn every_exported_symbol_is_declared_in_the_header() {
    let symbols = exported();
    assert!(!symbols.is_empty(), "parser found no exports — it has drifted from the source");
    let missing: Vec<&String> = symbols
        .iter()
        .filter(|name| !HEADER.contains(name.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "exported but undeclared in aghoz.h: {missing:?}"
    );
}

#[test]
fn every_header_declaration_exists_in_the_source() {
    let exported = exported();
    let mut undefined = Vec::new();
    for line in HEADER.lines() {
        let trimmed = line.trim();
        // Declarations only; skip comments, macros and typedefs.
        if trimmed.starts_with('*')
            || trimmed.starts_with("/*")
            || trimmed.starts_with('#')
            || trimmed.starts_with("typedef")
            || !trimmed.contains("ag_")
            || !trimmed.contains('(')
        {
            continue;
        }
        if let Some(open) = trimmed.find('(') {
            let head = &trimmed[..open];
            if let Some(name) = head.split_whitespace().last() {
                let name = name.trim_start_matches('*');
                if name.starts_with("ag_") && !exported.contains(&name.to_string()) {
                    undefined.push(name.to_string());
                }
            }
        }
    }
    assert!(
        undefined.is_empty(),
        "declared in aghoz.h but not exported: {undefined:?}"
    );
}

#[test]
fn status_codes_agree_between_source_and_header() {
    // A binding that reads -6 as "topic too long" would map a 429 to a 400.
    for (name, value) in [
        ("AG_OK", "0"),
        ("AG_ERR_TOPIC_EMPTY", "-1"),
        ("AG_ERR_TOPIC_TOO_LONG", "-2"),
        ("AG_ERR_TOPIC_CONTROL", "-3"),
        ("AG_ERR_TOPIC_RESERVED", "-4"),
        ("AG_ERR_TOPIC_COUNT", "-5"),
        ("AG_ERR_MAX_CONNECTIONS", "-6"),
        ("AG_ERR_MAX_CONNECTIONS_PER_KEY", "-7"),
        ("AG_ERR_NULL", "-8"),
        ("AG_ERR_UTF8", "-9"),
        ("AG_ERR_PANIC", "-10"),
        ("AG_ERR_POISONED", "-11"),
        ("AG_ERR_ORIGIN_EMPTY", "-12"),
        ("AG_ERR_ORIGIN_TOO_LONG", "-13"),
        ("AG_ERR_ORIGIN_CONTROL", "-14"),
        ("AG_ERR_MALFORMED_ID", "-15"),
        ("AG_BUFFER_SLOW_CONSUMER", "1"),
        ("AG_CHECKPOINT_EARLIEST", "2"),
        ("AG_GAP_SLOW_CONSUMER", "1"),
    ] {
        let in_header = HEADER
            .lines()
            .filter(|l| l.trim_start().starts_with("#define"))
            .any(|l| {
                let mut parts = l.split_whitespace();
                parts.next();
                parts.next() == Some(name) && parts.next() == Some(value)
            });
        assert!(in_header, "{name} must be {value} in aghoz.h");

        let in_source = SOURCE
            .lines()
            .any(|l| l.contains(&format!("pub const {name}: i32 = {value};")));
        assert!(in_source, "{name} must be {value} in lib.rs");
    }
}
