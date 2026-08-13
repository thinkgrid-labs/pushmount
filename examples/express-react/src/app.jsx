import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  PushmountProvider,
  useTopic,
  useTopicReducer,
  useConnectionState,
} from '@pushmount/react'

const orgId = new URLSearchParams(location.search).get('org') ?? '42'

function Revenue({ initial }) {
  // This line is the whole migration. What it replaced:
  //
  //   const { data } = useQuery({
  //     queryKey: ['revenue'], queryFn: fetchRevenue,
  //     refetchInterval: 5000,        // 720 requests per hour, per tab
  //   })
  const revenue = useTopic(`org/${orgId}/revenue`, initial)
  return (
    <div className="stat">
      <span className="label">Revenue</span>
      <strong>{revenue.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>
    </div>
  )
}

function Orders({ initial }) {
  // A last-value hook cannot express a growing list: the event carries one order, not
  // the collection containing it. This folds instead.
  const orders = useTopicReducer(
    `org/${orgId}/orders`,
    (list, order) => [order, ...list].slice(0, 8),
    initial,
  )

  if (orders.length === 0) return <p className="empty">No orders yet. Place one below.</p>

  return (
    <ul className="orders">
      {orders.map((o) => (
        <li key={o.id}>
          <code>{o.id}</code>
          <span>{(o.total / 100).toFixed(2)}</span>
        </li>
      ))}
    </ul>
  )
}

function Status() {
  const state = useConnectionState()
  return <span className={`status ${state}`}>{state}</span>
}

function PlaceOrder() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        // An ordinary write through the API that already existed. No client-to-server
        // messaging over the stream — that is a permanent non-goal.
        await fetch(`/api/orders?org=${orgId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        setBusy(false)
      }}
    >
      Place an order
    </button>
  )
}

function App({ boot }) {
  const [gap, setGap] = useState(null)

  return (
    <PushmountProvider
      url="/events"
      // Closes the window between this page's data being read and the stream opening.
      // Without it, an order placed during that gap is lost with nothing reported.
      initialCursor={boot.cursor}
      // The line that makes stale state impossible rather than unlikely. In a real app
      // this is queryClient.invalidateQueries().
      onGap={(reason) => {
        setGap(reason)
        fetch(`/api/bootstrap?org=${orgId}`)
          .then((r) => r.json())
          .then(() => setGap(null))
      }}
      onDenied={(topics) => console.warn('not authorized for', topics)}
      onError={(error) => console.error(error)}
    >
      <header>
        <h1>
          org/{orgId} <Status />
        </h1>
        <PlaceOrder />
      </header>

      {gap !== null && <p className="gap">Missed updates ({gap}) — refetching.</p>}

      <Revenue initial={boot.revenue} />
      <h2>Recent orders</h2>
      <Orders initial={boot.orders} />

      <footer>
        Open this page in two tabs, or as{' '}
        <a href={`/?org=${orgId === '42' ? '99' : '42'}`}>another org</a> to see that a
        publish only reaches subscribers authorized for it.
      </footer>
    </PushmountProvider>
  )
}

function Boot() {
  const [boot, setBoot] = useState(null)
  useEffect(() => {
    fetch(`/api/bootstrap?org=${orgId}`)
      .then((r) => r.json())
      .then(setBoot)
  }, [])
  if (boot === null) return <p className="empty">Loading…</p>
  return <App boot={boot} />
}

createRoot(document.getElementById('root')).render(<Boot />)
