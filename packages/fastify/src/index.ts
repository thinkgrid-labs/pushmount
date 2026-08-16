/**
 * @aghoz/fastify
 *
 * Fastify keeps its own request wrapper: decorations like `request.user` live there,
 * while the socket and its close events live on `request.raw`. The handler needs both,
 * which is what `toNodeRequest` exists for — see HandlerOptions in @aghoz/server.
 *
 * The other half is `reply.hijack()`. Without it Fastify assumes it owns the response
 * lifecycle and will try to serialise and end it, which truncates the stream.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { createHub } from '@aghoz/server'

type Hub = ReturnType<typeof createHub>

export interface AghozFastifyOptions {
  hub: Hub
  /** Route the stream is mounted at. `${path}/cursor` is registered alongside it. */
  path?: string
  /** §4.3 — receives the Fastify request, so decorations are available. */
  authorize?: (req: FastifyRequest, topic: string) => boolean | Promise<boolean>
  /** §10 — per-key connection cap, typically by user id. */
  connectionKey?: (req: FastifyRequest) => string | undefined
}

/**
 * Registers the stream and cursor routes on a Fastify instance.
 *
 * ```js
 * await registerAghoz(app, {
 *   hub,
 *   authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
 * })
 * ```
 */
export async function registerAghoz(
  fastify: FastifyInstance,
  options: AghozFastifyOptions,
): Promise<void> {
  const path = options.path ?? '/events'
  const stream = toFastifyHandler(options)

  fastify.get(path, stream)
  fastify.get(`${path}/cursor`, async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store')
    // §5 — the shared sequence's answer where there is one, matching what the Node
    // `cursorHandler` serves. A per-process cursor from a worker that has just joined the
    // cluster is `0-0`, and a page stamped with it is answered by the stream with a gap.
    await options.hub.ready()
    return { cursor: await options.hub.sharedCursor() }
  })
}

/** The stream route on its own, for callers wiring routes themselves. */
export function toFastifyHandler(options: AghozFastifyOptions) {
  const handler = options.hub.handler<FastifyRequest>({
    ...(options.authorize !== undefined && { authorize: options.authorize }),
    ...(options.connectionKey !== undefined && { connectionKey: options.connectionKey }),
    // Fastify's request is not an IncomingMessage; the raw one is.
    toNodeRequest: (req) => req.raw,
  })

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Hands the response to us. Fastify will not touch it again.
    reply.hijack()
    await handler(request, reply.raw)
  }
}
