/**
 * @aghoz/nest
 *
 * ## Nest's own `@Sse()` cannot be used, and that is why this package exists
 *
 * `@Sse()` takes an Observable and writes the response itself. It chooses the status, the
 * headers and the framing, and it offers no way to add one of its own. Two things this
 * protocol requires are therefore unreachable through it:
 *
 * - **`last-event-id-checkpoint`** (§4.4). The server knows before it writes a single body
 *   byte whether it can honour the client's cursor. That answer goes in the head, and with
 *   `@Sse()` there is no head to put it in — so a client can never be told it missed
 *   events, which is the entire point of the library.
 * - **The `~gap` frame ordering** (§4.5). `@Sse()` maps one Observable value to one frame;
 *   it cannot emit control frames before replay begins.
 *
 * This is the same reason `@aghoz/client` does not use `EventSource`: an abstraction that
 * owns the response owns what can be said in it.
 *
 * So the route here takes the response over with `@Res()`, which puts Nest in
 * library-specific mode and stops it touching the response at all.
 *
 * ## What this package does and does not do
 *
 * It provides the hub through Nest's injector and ties `hub.close()` to the application
 * lifecycle. It does **not** mount a controller for you.
 *
 * That is deliberate. A route this package registered would carry none of your
 * `@UseGuards()`, and guards are where a Nest application's authentication lives — so an
 * auto-mounted stream would be the one route in your app that bypassed it. The premise of
 * this library is that your authentication runs *before* the hub sees a request; mounting
 * our own route would quietly break exactly that. You write a controller, put your guards
 * on it, and hand us the request.
 */

import { Inject, Module } from '@nestjs/common'
import type {
  BeforeApplicationShutdown,
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  Provider,
} from '@nestjs/common'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHub, type CreateHubOptions, type HandlerOptions } from '@aghoz/server'

type Hub = ReturnType<typeof createHub>

/** Injection token for the hub. `@Inject(AGHOZ_HUB)`, or the `InjectHub()` sugar below. */
export const AGHOZ_HUB = Symbol.for('aghoz.hub')

/** `constructor(@InjectHub() private readonly hub: AghozHub) {}` */
export const InjectHub = (): ReturnType<typeof Inject> => Inject(AGHOZ_HUB)

/** The injected type. `createHub`'s return, named so it can be written in a constructor. */
export type AghozHub = Hub

export interface AghozModuleOptions extends CreateHubOptions {
  /**
   * An existing hub, if your application already made one.
   *
   * Supplying this ignores every other option here — they configure the hub this would
   * otherwise create.
   */
  hub?: Hub
  /**
   * Registers the module globally, so feature modules can inject the hub without
   * importing it. Default false, because a global module is a dependency that does not
   * appear in the graph.
   */
  global?: boolean
}

export interface AghozModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest's own factory shape
  useFactory: (...args: any[]) => AghozModuleOptions | Promise<AghozModuleOptions>
  /** Providers passed to `useFactory`, in order. Nest's `FactoryProvider` shape exactly. */
  inject?: FactoryProvider['inject']
  global?: boolean
}

/**
 * Closes the hub when the application shuts down.
 *
 * **`beforeApplicationShutdown`, not `onApplicationShutdown`** — and the difference is the
 * whole reason this class exists rather than a line in the README. Nest tears down in this
 * order:
 *
 *   1. `onModuleDestroy`
 *   2. `beforeApplicationShutdown`
 *   3. the HTTP server is closed
 *   4. `onApplicationShutdown`
 *
 * `server.close()` in step 3 stops accepting new connections and then waits for the open
 * ones to end. An SSE stream never ends on its own — that is what it is for — so a hub
 * still holding subscribers at step 3 means `app.close()` never resolves. Closing at step
 * 4 is too late to help: nothing reaches it.
 *
 * Dropping the subscribers at step 2 lets step 3 find an idle server and return. Without
 * it a Nest application with one open stream hangs on shutdown, and the first place anyone
 * meets that is a test suite that passes every assertion and then never exits.
 */
class AghozLifecycle implements BeforeApplicationShutdown {
  constructor(@Inject(AGHOZ_HUB) private readonly hub: Hub) {}

  beforeApplicationShutdown(): void {
    this.hub.close()
  }
}

@Module({})
export class AghozModule {
  /**
   * ```ts
   * @Module({ imports: [AghozModule.forRoot({ maxHistoryBytes: 16 * 1024 * 1024 })] })
   * export class AppModule {}
   * ```
   */
  static forRoot(options: AghozModuleOptions = {}): DynamicModule {
    const { hub, global = false, ...hubOptions } = options
    const provider: Provider = {
      provide: AGHOZ_HUB,
      useValue: hub ?? createHub(hubOptions),
    }
    return {
      module: AghozModule,
      global,
      providers: [provider, AghozLifecycle],
      exports: [AGHOZ_HUB],
    }
  }

  /**
   * For a hub whose configuration is not known at import time.
   *
   * The Redis backplane is the case that makes this necessary rather than merely tidy:
   * `createRedisBackplane` is async, so a multi-process deployment cannot build its hub
   * synchronously.
   *
   * ```ts
   * AghozModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: async (config: ConfigService) => ({
   *     backplane: await createRedisBackplane({
   *       redis: new Redis(config.get('REDIS_URL')),
   *       subscriber: new Redis(config.get('REDIS_URL')),
   *     }),
   *   }),
   * })
   * ```
   */
  static forRootAsync(options: AghozModuleAsyncOptions): DynamicModule {
    const provider: FactoryProvider = {
      provide: AGHOZ_HUB,
      useFactory: async (...args: unknown[]) => {
        const resolved = await options.useFactory(...args)
        const { hub, global: _global, ...hubOptions } = resolved
        return hub ?? createHub(hubOptions)
      },
      inject: options.inject ?? [],
    }
    return {
      module: AghozModule,
      global: options.global ?? false,
      ...(options.imports !== undefined && { imports: options.imports }),
      providers: [provider, AghozLifecycle],
      exports: [AGHOZ_HUB],
    }
  }
}

/**
 * A Fastify reply, structurally.
 *
 * Declared rather than imported because `fastify` is not a dependency of this package and
 * must not become one — a Nest application on the Express platform would then install it
 * for a type it never uses.
 */
interface FastifyLike {
  hijack(): void
  raw: ServerResponse
}

function isFastifyReply(res: unknown): res is FastifyLike {
  return typeof res === 'object' && res !== null && typeof (res as FastifyLike).hijack === 'function'
}

function rawRequest(req: unknown): IncomingMessage {
  const wrapper = req as { raw?: IncomingMessage }
  // FastifyRequest keeps the socket on `.raw`; an Express request *is* the socket's
  // request. Getting this wrong is silent: `authorize` would receive an object with none
  // of the framework's decorations, and every topic would be denied — or allowed.
  return wrapper.raw ?? (req as IncomingMessage)
}

export interface AghozHandlerOptions<Req> {
  /**
   * §4.3 — receives the request Nest built, *after* your guards and middleware have run,
   * so whatever they attached (`req.user`, typically) is available.
   */
  authorize?: (req: Req, topic: string) => boolean | Promise<boolean>
  /** §10 — groups connections for the per-key cap, usually by user id. */
  connectionKey?: (req: Req) => string | undefined
  /** §4.6 — re-runs `authorize` on live connections on an interval. Default 0, off. */
  revalidateMs?: number
}

/**
 * Builds the stream route handler.
 *
 * **Call this once, in the controller's constructor — never inside the route method.**
 * `revalidateMs` schedules an interval per handler, so building one per request leaks a
 * timer for every connection your application ever serves.
 *
 * ```ts
 * @Controller('events')
 * @UseGuards(AuthGuard)
 * export class EventsController {
 *   private readonly stream: ReturnType<typeof createAghozHandler>
 *
 *   constructor(@InjectHub() private readonly hub: AghozHub) {
 *     this.stream = createAghozHandler(hub, {
 *       authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
 *       connectionKey: (req) => req.user.id,
 *     })
 *   }
 *
 *   @Get()
 *   events(@Req() req: Request, @Res() res: Response) {
 *     return this.stream(req, res)
 *   }
 *
 *   @Get('cursor')
 *   cursor() {
 *     return { cursor: this.hub.cursor() }
 *   }
 * }
 * ```
 *
 * Use a bare `@Res()`. `@Res({ passthrough: true })` leaves Nest in charge of ending the
 * response, and it will end it — closing the stream as soon as the method returns.
 *
 * Works on both platforms. On Fastify the reply is hijacked first, without which Fastify
 * serialises and ends the response mid-stream.
 */
export function createAghozHandler<Req = unknown>(
  hub: Hub,
  options: AghozHandlerOptions<Req> = {},
): (req: Req, res: unknown) => Promise<void> {
  const handlerOptions: HandlerOptions<Req> & { toNodeRequest: (req: Req) => IncomingMessage } = {
    ...(options.authorize !== undefined && { authorize: options.authorize }),
    ...(options.connectionKey !== undefined && { connectionKey: options.connectionKey }),
    ...(options.revalidateMs !== undefined && { revalidateMs: options.revalidateMs }),
    toNodeRequest: rawRequest,
  }

  // `hub.handler` demands `toNodeRequest` through a conditional type — `Req extends
  // IncomingMessage ? unknown : { toNodeRequest }` — so that a caller passing a framework
  // request cannot forget it. That condition cannot be evaluated against an unresolved
  // type parameter, which is exactly what `Req` is here, so the compiler refuses a
  // structurally correct value. The cast is safe because the property the condition asks
  // for is supplied immediately above, and it is a function only this module writes.
  const handler = hub.handler<Req>(
    handlerOptions as Parameters<typeof hub.handler<Req>>[0],
  )

  return async (req: Req, res: unknown): Promise<void> => {
    if (isFastifyReply(res)) {
      // Hands the response over. Fastify will not touch it again.
      res.hijack()
      await handler(req, res.raw)
      return
    }
    await handler(req, res as ServerResponse)
  }
}
