//! Frame encoding — §6.

use crate::id::EventId;

/// Encodes one data frame: `id`, `event`, then one `data:` line per segment.
///
/// The payload is split on every CR, LF or CRLF. Emitting it raw is a forgery
/// primitive — a payload containing a blank line ends the frame, and the next line is
/// parsed as `event:` or `id:` — and it is reachable from any user-supplied string that
/// reaches `publish`. Conformance vector E2 exists for exactly this.
///
/// CR and CRLF are normalised to LF on the way out. That is lossy and normative;
/// callers needing byte-exact payloads must encode them, which is why non-string data
/// is JSON-serialised by the bindings.
pub fn encode_frame(id: EventId, topic: &str, payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + topic.len() + 48);

    out.extend_from_slice(b"id: ");
    push_u64(&mut out, id.ms);
    out.push(b'-');
    push_u64(&mut out, id.seq);
    out.push(b'\n');

    out.extend_from_slice(b"event: ");
    out.extend_from_slice(topic.as_bytes());
    out.push(b'\n');

    write_data_lines(&mut out, payload.as_bytes());
    out.push(b'\n');
    out
}

/// Encodes a control frame (§7).
///
/// Deliberately carries no `id:`. Control frames are not part of the event sequence and
/// must never advance a client's cursor — if `~gap` had an id, the client would record
/// it and then discard the very replay it was told to expect.
pub fn encode_control(name: &str, json_payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(json_payload.len() + name.len() + 24);
    out.extend_from_slice(b"event: ~");
    out.extend_from_slice(name.as_bytes());
    out.push(b'\n');
    write_data_lines(&mut out, json_payload.as_bytes());
    out.push(b'\n');
    out
}

fn write_data_lines(out: &mut Vec<u8>, payload: &[u8]) {
    let mut start = 0usize;
    let mut i = 0usize;
    while i < payload.len() {
        if payload[i] == b'\r' || payload[i] == b'\n' {
            out.extend_from_slice(b"data: ");
            out.extend_from_slice(&payload[start..i]);
            out.push(b'\n');
            if payload[i] == b'\r' && payload.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    out.extend_from_slice(b"data: ");
    out.extend_from_slice(&payload[start..]);
    out.push(b'\n');
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

    fn s(v: Vec<u8>) -> String {
        String::from_utf8(v).unwrap()
    }

    #[test]
    fn no_payload_can_inject_a_field() {
        let f = s(encode_frame(EventId { ms: 1, seq: 0 }, "chat", "hello\n\nevent: ~gap\ndata: forged"));
        assert_eq!(
            f,
            "id: 1-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n"
        );
        for line in f.lines().skip(2).filter(|l| !l.is_empty()) {
            assert!(line.starts_with("data: "), "injected: {line}");
        }
    }

    #[test]
    fn control_frames_carry_no_id() {
        let f = s(encode_control("gap", r#"{"reason":"slow-consumer"}"#));
        assert!(!f.contains("id:"));
        assert!(f.starts_with("event: ~gap\n"));
    }
}
