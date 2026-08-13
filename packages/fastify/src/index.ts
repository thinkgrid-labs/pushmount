/**
 * @pushmount/fastify
 *
 * Fastify keeps its own request wrapper: decorations like `request.user` live there,
 * while the socket and its close events live on `request.raw`. The handler needs both,
 * which is what `toNodeRequest` exists for — see HandlerOptions in @pushmount/server.
 *
 * The other half is `reply.hijack()`. Without it Fastify assumes it owns the response
 * lifecycle and will try to serialise and end it, which truncates the stream.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { createHub } from '@pushmount/server'

type Hub = ReturnType<typeof createHub>

export interface PushmountFastifyOptions {
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
 * await registerPushmount(app, {
 *   hub,
 *   authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
 * })
 * ```
 */
export async function registerPushmount(
  fastify: FastifyInstance,
  options: PushmountFastifyOptions,
): Promise<void> {
  const path = options.path ?? '/events'
  const stream = toFastifyHandler(options)

  fastify.get(path, stream)
  fastify.get(`${path}/cursor`, async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store')
    return { cursor: options.hub.cursor() }
  })
}

/** The stream route on its own, for callers wiring routes themselves. */
export function toFastifyHandler(options: PushmountFastifyOptions) {
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
