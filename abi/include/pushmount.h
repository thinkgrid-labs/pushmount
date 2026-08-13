/*
 * pushmount — stable C ABI.
 *
 * The single surface every language binding targets. See PROTOCOL.md for what the
 * operations mean; this file describes only how to call them.
 *
 * Ownership
 *   Anything returned through an out-parameter or as a pointer is owned by the library
 *   and must be released with its matching *_free. Never call free() on it. Every
 *   *_free tolerates NULL.
 *
 * Strings
 *   pm_str is a pointer and a length. Nothing is assumed NUL-terminated: payloads may
 *   legitimately contain NUL bytes, and strlen() here would silently truncate them.
 *   All strings must be valid UTF-8; invalid input returns PM_ERR_UTF8 rather than
 *   being reinterpreted.
 *
 * Threading
 *   pm_hub is internally synchronised. Calls from multiple threads are safe. Result
 *   objects (pm_publish_result, pm_subscribe_result, pm_buf) are not — do not share one
 *   across threads without your own synchronisation.
 *
 * Errors
 *   Functions returning int32_t return PM_OK or a negative PM_ERR_*. No panic ever
 *   crosses this boundary; an internal failure surfaces as PM_ERR_PANIC.
 */

#ifndef PUSHMOUNT_H
#define PUSHMOUNT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- status codes ------------------------------------------------------- */

#define PM_OK                            0
#define PM_ERR_TOPIC_EMPTY              -1
#define PM_ERR_TOPIC_TOO_LONG           -2   /* 255 BYTES, not characters */
#define PM_ERR_TOPIC_CONTROL            -3
#define PM_ERR_TOPIC_RESERVED           -4   /* began with '~' */
#define PM_ERR_TOPIC_COUNT              -5
#define PM_ERR_MAX_CONNECTIONS          -6   /* map to HTTP 429 */
#define PM_ERR_MAX_CONNECTIONS_PER_KEY  -7   /* map to HTTP 429 */
#define PM_ERR_NULL                     -8
#define PM_ERR_UTF8                     -9
#define PM_ERR_PANIC                   -10
#define PM_ERR_POISONED                -11

/* pm_note_buffer verdicts */
#define PM_BUFFER_OK                     0
#define PM_BUFFER_SLOW_CONSUMER          1
#define PM_BUFFER_UNKNOWN                2

/* pm_subscribe_checkpoint results — what the last-event-id-checkpoint header says */
#define PM_CHECKPOINT_ABSENT             0   /* omit the header */
#define PM_CHECKPOINT_ECHO               1   /* echo the cursor back */
#define PM_CHECKPOINT_EARLIEST           2   /* send "earliest", and a ~gap frame */

/* pm_gap_frame reasons */
#define PM_GAP_HISTORY_TRUNCATED         0
#define PM_GAP_SLOW_CONSUMER             1

/* ---- types -------------------------------------------------------------- */

typedef struct pm_hub pm_hub;
typedef struct pm_publish_result pm_publish_result;
typedef struct pm_subscribe_result pm_subscribe_result;
typedef struct pm_buf pm_buf;

/* A borrowed byte string. ptr may be NULL only when len is 0. */
typedef struct {
  const uint8_t *ptr;
  size_t len;
} pm_str;

/* Limits. Zero means "default" for every field, so a zero-initialised struct yields a
 * working hub rather than one that refuses every connection. */
typedef struct {
  uint64_t max_history_bytes;         /* 0 -> 8 MiB. Bytes, not events. */
  uint64_t max_buffer_bytes;          /* 0 -> 1 MiB */
  uint64_t max_connections;           /* 0 -> unlimited */
  uint64_t max_connections_per_key;   /* 0 -> unlimited */
  uint64_t max_topics_per_connection; /* 0 -> 64 */
} pm_config;

/* ---- lifecycle ---------------------------------------------------------- */

/* major * 1000 + minor. Refuse to load a library whose major differs. */
uint32_t pm_abi_version(void);

pm_hub *pm_hub_new(const pm_config *config); /* config may be NULL for all defaults */
void pm_hub_free(pm_hub *hub);

/* ---- publish ------------------------------------------------------------ */

/* Assigns an id, encodes a frame, and matches subscribers.
 * On PM_OK, *out receives a result to release with pm_publish_result_free. */
int32_t pm_publish(pm_hub *hub, uint64_t now_ms, pm_str topic, pm_str payload,
                   pm_publish_result **out);

const uint8_t *pm_publish_frame(const pm_publish_result *result, size_t *len);
const uint64_t *pm_publish_targets(const pm_publish_result *result, size_t *count);
void pm_publish_id(const pm_publish_result *result, uint64_t *ms, uint64_t *seq);
void pm_publish_result_free(pm_publish_result *result);

/* ---- subscribe ---------------------------------------------------------- */

/* Registers a subscriber, decides the checkpoint, and snapshots the replay set.
 *
 * These are one call because the protocol requires them to describe one instant.
 * Splitting them across two FFI calls would let a publish land in between and leave a
 * real gap unreported, so the pieces are deliberately not offered separately.
 *
 * key may be empty to opt out of the per-key cap. has_cursor is 0 or 1. */
int32_t pm_subscribe(pm_hub *hub, const pm_str *topics, size_t topic_count, pm_str key,
                     int32_t has_cursor, uint64_t cursor_ms, uint64_t cursor_seq,
                     pm_subscribe_result **out);

uint64_t pm_subscribe_id(const pm_subscribe_result *result); /* never 0 on success */
int32_t pm_subscribe_checkpoint(const pm_subscribe_result *result);
size_t pm_subscribe_replay_count(const pm_subscribe_result *result);
/* Oldest first. Returns NULL when index is out of range. */
const uint8_t *pm_subscribe_replay_at(const pm_subscribe_result *result, size_t index,
                                      size_t *len);
void pm_subscribe_result_free(pm_subscribe_result *result);

/* ---- subscriber operations ---------------------------------------------- */

/* Reports the socket's current queued depth — absolute, not a delta. Returns a
 * PM_BUFFER_* verdict. */
int32_t pm_note_buffer(pm_hub *hub, uint64_t subscriber, uint64_t queued_bytes);

/* Idempotent. Returns 1 if the subscriber existed, 0 if not. */
int32_t pm_remove(pm_hub *hub, uint64_t subscriber);

int64_t pm_connection_count(pm_hub *hub); /* negative on error */
int32_t pm_cursor(pm_hub *hub, uint64_t *ms, uint64_t *seq);

/* ---- control frames ----------------------------------------------------- */

/* Both return a buffer to release with pm_buf_free, or NULL on error. */
pm_buf *pm_gap_frame(pm_hub *hub, uint64_t subscriber, int32_t reason);
pm_buf *pm_denied_frame(pm_hub *hub, const pm_str *topics, size_t topic_count);

const uint8_t *pm_buf_data(const pm_buf *buf, size_t *len);
void pm_buf_free(pm_buf *buf);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PUSHMOUNT_H */
