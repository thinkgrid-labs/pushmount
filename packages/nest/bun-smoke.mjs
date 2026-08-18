// A small production-shape gate for NestJS running on Bun.
//
// Bun's `bun test` does not implement every `node:test` behaviour used by the full
// package suite. This executable smoke test avoids a second test-runner contract while
// still booting the exact Nest Express path a Bun application will use.

import 'reflect-metadata'
import assert from 'node:assert/strict'
import { Controller, Get, Inject, Injectable, Module, Req, Res, UseGuards } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AGHOZ_HUB, AghozModule, createAghozHandler } from './dist/index.js'

assert.ok(process.versions.bun, 'this smoke test must run under Bun')

function decorateMethod(cls, method, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, method)
  for (const decorator of decorators) decorator(cls.prototype, method, descriptor)
}

class AuthGuard {
  canActivate(context) {
    const req = context.switchToHttp().getRequest()
    if (req.headers.authorization !== 'Bearer bun-smoke') return false
    req.user = { id: 'admin-1', orgId: '42' }
    return true
  }
}
Injectable()(AuthGuard)

class EventsController {
  constructor(hub) {
    this.hub = hub
    this.stream = createAghozHandler(hub, {
      authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
      connectionKey: (req) => req.user.id,
    })
  }

  async events(req, res) {
    return this.stream(req, res)
  }
}

Inject(AGHOZ_HUB)(EventsController, undefined, 0)
Controller('events')(EventsController)
UseGuards(AuthGuard)(EventsController)
decorateMethod(EventsController, 'events', Get())
Req()(EventsController.prototype, 'events', 0)
Res()(EventsController.prototype, 'events', 1)

class AppModule {}
Module({
  imports: [AghozModule.forRoot({ keepAliveMs: 0 })],
  controllers: [EventsController],
})(AppModule)

function openStream(url) {
  const controller = new AbortController()
  const frames = []

  return fetch(url, {
    signal: controller.signal,
    headers: { authorization: 'Bearer bun-smoke' },
  }).then((response) => {
    const reader = response.body?.getReader()
    if (reader !== undefined) {
      const decoder = new TextDecoder()
      let buffer = ''
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              frames.push(buffer.slice(0, boundary + 2))
              buffer = buffer.slice(boundary + 2)
            }
          }
        } catch {
          // Expected when the smoke test aborts its long-lived response.
        }
      })()
    }

    return {
      response,
      async waitFor(match, timeoutMs = 3_000) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const frame = frames.find(match)
          if (frame !== undefined) return frame
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for frame; received ${JSON.stringify(frames)}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      },
      close() {
        controller.abort()
      },
    }
  })
}

const app = await NestFactory.create(AppModule, { logger: false })
let stream

try {
  await app.listen(0, '127.0.0.1')
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1')
  const hub = app.get(AGHOZ_HUB)
  const cursor = hub.cursor()

  const denied = await fetch(`${base}/events?topics=org/99/books`, {
    headers: { authorization: 'Bearer bun-smoke' },
  })
  assert.equal(denied.status, 403)
  await denied.body?.cancel()

  await hub.publish('org/42/books', { id: 'before-connect' })
  stream = await openStream(
    `${base}/events?topics=org/42/books&last_event_id=${encodeURIComponent(cursor)}`,
  )

  assert.equal(stream.response.status, 200)
  assert.match(stream.response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(stream.response.headers.get('last-event-id-checkpoint'), cursor)
  await stream.waitFor((frame) => frame.includes('before-connect'))

  await hub.publish('org/42/books', { id: 'live' })
  await stream.waitFor((frame) => frame.includes('live'))

  console.log(`bun ${process.versions.bun}: NestJS stream smoke passed`)
} finally {
  stream?.close()
  await app.close()
}
