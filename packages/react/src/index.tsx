/**
 * @pushmount/react
 *
 * One connection for the whole tree, and a hook where you render.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createClient,
  type Client,
  type ClientOptions,
  type ClientState,
  type EventMeta,
  type GapReason,
} from '@pushmount/client'

const PushmountContext = createContext<Client | null>(null)

export interface PushmountProviderProps {
  /** The mounted path, e.g. `/events`. */
  url: string
  /**
   * The cursor read alongside the page's initial data — see PROTOCOL.md §5.
   *
   * Without it, anything published between the server rendering this page and the
   * browser opening the stream is lost with nothing reported.
   */
  initialCursor?: string
  /**
   * Fires when updates were provably missed. Wiring this to a refetch is what makes
   * stale state impossible rather than unlikely; it is the reason to use this library
   * over fifteen lines of hand-rolled SSE.
   */
  onGap?: (reason: GapReason, topics: readonly string[]) => void
  onDenied?: (topics: readonly string[]) => void
  onError?: (error: unknown) => void
  /** Supply your own client — useful in tests, or to share one across two trees. */
  client?: Client
  children?: ReactNode
}

export function PushmountProvider(props: PushmountProviderProps): ReactNode {
  const { url, initialCursor, onGap, onDenied, onError, client: provided, children } = props

  // Callbacks live behind a ref so that a parent re-render with new inline functions
  // does not tear down the connection. Reconnecting because a component re-rendered
  // would discard the cursor and cause exactly the loss this library reports.
  const callbacks = useRef({ onGap, onDenied, onError })
  callbacks.current = { onGap, onDenied, onError }

  const client = useMemo(() => {
    if (provided !== undefined) return provided
    const options: ClientOptions = {
      url,
      onGap: (reason, topics) => callbacks.current.onGap?.(reason, topics),
      onDenied: (topics) => callbacks.current.onDenied?.(topics),
      onError: (error) => callbacks.current.onError?.(error),
      ...(initialCursor !== undefined && { initialCursor }),
    }
    return createClient(options)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- url/cursor identify the connection
  }, [provided, url, initialCursor])

  useEffect(() => {
    // Only close a client this provider created; a supplied one is the caller's.
    if (provided !== undefined) return
    return () => client.close()
  }, [client, provided])

  return createElement(PushmountContext.Provider, { value: client }, children)
}

export function usePushmount(): Client {
  const client = useContext(PushmountContext)
  if (client === null) {
    throw new Error('usePushmount must be used inside a <PushmountProvider>')
  }
  return client
}

/** The live connection state, for a status indicator. */
export function useConnectionState(): ClientState {
  const client = usePushmount()
  const [state, setState] = useState<ClientState>(client.state)
  useEffect(() => {
    setState(client.state)
    const id = setInterval(() => setState(client.state), 250)
    return () => clearInterval(id)
  }, [client])
  return state
}

export interface TopicOptions<T> {
  /**
   * Turns the wire payload into a value. Defaults to `JSON.parse`, which mirrors the
   * server serialising non-string data.
   *
   * Publishing a raw string that is not valid JSON needs `parse: (s) => s`. The
   * default is not a guess-and-fall-back, because a silent fallback would make
   * `publish(topic, '42')` sometimes a number and sometimes a string.
   */
  parse?: (raw: string) => T
}

function useParse<T>(options?: TopicOptions<T>): (raw: string) => T {
  const parse = options?.parse
  return useMemo(() => parse ?? ((raw: string) => JSON.parse(raw) as T), [parse])
}

/**
 * Subscribes to a topic and returns the most recent value.
 *
 * This is a last-value cell. It is the right shape for a dashboard number or a status,
 * and the wrong shape for a growing collection — an event carrying one new order gives
 * you that order, not the list containing it. Use `useTopicReducer` for collections.
 */
export function useTopic<T>(topic: string, initial: T, options?: TopicOptions<T>): T {
  const client = usePushmount()
  const parse = useParse(options)
  const [value, setValue] = useState<T>(initial)

  useEffect(() => {
    return client.subscribe(topic, (raw) => {
      setValue(parse(raw))
    })
  }, [client, topic, parse])

  return value
}

/** Subscribes without holding state — for toasts, invalidation, imperative work. */
export function useTopicEffect<T = unknown>(
  topic: string,
  fn: (value: T, meta: EventMeta) => void,
  options?: TopicOptions<T>,
): void {
  const client = usePushmount()
  const parse = useParse(options)
  // Behind a ref so an inline callback does not resubscribe on every render, which
  // would churn the topic set and, via §9.3, reconnect the shared stream.
  const handler = useRef(fn)
  handler.current = fn

  useEffect(() => {
    return client.subscribe(topic, (raw, meta) => {
      handler.current(parse(raw), meta)
    })
  }, [client, topic, parse])
}

/**
 * Folds events into state — the shape a collection needs.
 *
 * `useTopic` cannot express a live list, which is one of the use cases this library
 * claims to serve, so this exists rather than leaving every consumer to hand-roll the
 * same append-and-cap reducer.
 */
export function useTopicReducer<S, T = unknown>(
  topic: string,
  reducer: (state: S, value: T, meta: EventMeta) => S,
  initial: S,
  options?: TopicOptions<T>,
): S {
  const client = usePushmount()
  const parse = useParse(options)
  const [state, setState] = useState<S>(initial)

  const reduce = useRef(reducer)
  reduce.current = reducer

  useEffect(() => {
    return client.subscribe(topic, (raw, meta) => {
      const value = parse(raw)
      setState((current) => reduce.current(current, value, meta))
    })
  }, [client, topic, parse])

  return state
}

export type { Client, ClientState, GapReason, EventMeta } from '@pushmount/client'
