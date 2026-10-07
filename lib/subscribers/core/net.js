/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const BaseCoreSubscriber = require('./base')
const shimmer = require('../../shimmer')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { tracingChannel } = require('node:diagnostics_channel')

const CREATE_METHODS = ['connect', 'createConnection']
const SOCKET_CONNECT = 'Socket.connect'
const SERVER_ON_CONNECTION = 'Server.onconnection'

class NetSubscriber extends BaseCoreSubscriber {
  constructor({ agent, logger }) {
    super({
      agent,
      logger,
      packageName: 'net',
      instrumentedMethods: [...CREATE_METHODS, SOCKET_CONNECT, SERVER_ON_CONNECTION]
    })
  }

  instrument(net) {
    this.#wrapCreate(net)
    this.#wrapNoRecord(net.Server.prototype)
    this.#wrapListen2(net.Server.prototype)
    this.#wrapConnect(net.Socket.prototype)
  }

  #wrapCreate(net) {
    const self = this
    const { tracer } = this.agent
    shimmer.wrapMethod(net, 'net', CREATE_METHODS, function wrapCreate(original, method) {
      const channel = tracingChannel(`${self.id}:${method}`)
      return function wrappedCreateConnection() {
        const data = { name: `${self.packageName}.${method}` }
        return channel.traceSync(function createInContext() {
          const sock = original.apply(this, arguments)
          // The base `start` handler only creates a segment, and thus enters a
          // new context, when a transaction is active. Only bind `emit` in that
          // case so sockets created outside a transaction are left untouched.
          const context = tracer.getContext()
          if (context?.transaction?.isActive()) {
            sock.emit = tracer.bindFunction(sock.emit, context)
          }
          return sock
        }, data, this, ...arguments)
      }
    })
  }

  #wrapNoRecord(serverProto) {
    const { tracer } = this.agent
    shimmer.wrapMethod(serverProto, 'net.Server.prototype', ['listen', 'close'], function wrapNoRecord(original) {
      return function wrappedNoRecord(...args) {
        const ctx = tracer.getContext()
        if (!ctx?.segment || !ctx.transaction?.isActive()) {
          return original.apply(this, args)
        }

        const cbIndex = args.length - 1

        args[cbIndex] = tracer.bindFunction(args[cbIndex], ctx)

        return original.apply(this, args)
      }
    })
  }

  #wrapListen2(serverProto) {
    const self = this
    const { tracer } = this.agent
    shimmer.wrapMethod(serverProto, 'net.Server.prototype', '_listen2', function wrapListen2(original) {
      const channel = tracingChannel(`${self.id}:${SERVER_ON_CONNECTION}`)
      return function wrappedListen2() {
        const context = tracer.getContext()
        const segment = context?.transaction?.isActive() ? context.segment : null
        const emit = this.emit

        if (!segment || !emit) {
          return original.apply(this, arguments)
        }

        this.emit = wrappedEmit

        return original.apply(this, arguments)

        function wrappedEmit(ev, socket) {
          if (ev !== 'connection' || !socket || !socket._handle) {
            return emit.apply(this, arguments)
          }

          const data = { name: `${self.packageName}.${SERVER_ON_CONNECTION}` }

          // The `connection` event fires long after `_listen2` returned, so the
          // listen-time context is no longer active. Re-enter it with `store.run`
          // so the base `start` handler parents the `onconnection` segment under
          // it; the traced function then runs with that new segment active.
          return self.store.run(context, () => channel.traceSync(function emitInContext() {
            const newContext = tracer.getContext()
            if (newContext?.transaction?.isActive() && socket._handle.onread) {
              socket._handle.onread = tracer.bindFunction(socket._handle.onread, newContext)
            }
            return emit.apply(this, arguments)
          }, data, this, ...arguments))
        }
      }
    })
  }

  #wrapConnect(socketProto) {
    const self = this
    const { tracer } = this.agent
    shimmer.wrapMethod(socketProto, 'net.Socket.prototype', 'connect', function wrapConnect(original) {
      const channel = tracingChannel(`${self.id}:${SOCKET_CONNECT}`)
      return function connectWrapper() {
        const data = { name: `${self.packageName}.${SOCKET_CONNECT}` }
        return channel.traceSync(function connectInContext() {
          // The base `start` handler has already created and entered the
          // segment when a transaction is active; otherwise there is nothing
          // to bind and the call runs unmodified.
          const context = tracer.getContext()
          if (!context?.transaction?.isActive()) {
            return original.apply(this, arguments)
          }

          const socket = this
          const args = normalizeConnectArgs(arguments)

          if (args[1]) {
            args[1] = tracer.bindFunction(args[1], context)
          }

          const result = original.apply(this, args)

          if (socket._handle) {
            socket._handle.onread = tracer.bindFunction(socket._handle.onread, context)
          }
          socket.emit = tracer.bindFunction(socket.emit, context)

          return result
        }, data, this, ...arguments)
      }
    })
  }
}

function normalizeConnectArgs(args) {
  let options = Object.create(null)

  function toNumber(x) {
    return (x = Number(x)) >= 0 ? x : false
  }
  if (typeof args[0] === 'object' && args[0] !== null) {
    // connect(options, [cb])
    options = args[0]
  } else if (typeof args[0] === 'string' && toNumber(args[0]) === false) {
    // connect(path, [cb]);
    options.path = args[0]
  } else {
    // connect(port, [host], [cb])
    options.port = args[0]
    if (typeof args[1] === 'string') {
      options.host = args[1]
    }
  }

  const cb = args[args.length - 1]
  return typeof cb === 'function' ? [options, cb] : [options]
}

module.exports = NetSubscriber
