/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict'

const Subscriber = require('../base')
const bedrockMiddlewareConfig = require('./middleware/bedrock')

const UNKNOWN = 'Unknown'
const MIDDLEWARE = Symbol('nrMiddleware')

// Service-specific middleware by client name
const middlewareByClient = {
  BedrockRuntime: [bedrockMiddlewareConfig]
}

/**
 * Subscriber for `@smithy/smithy-client` `Client.send()` calls. Registers
 * common AWS middleware (DT header suppression, response attributes) and
 * dispatches service-specific middleware via the `middlewareByClient` map.
 *
 * Only clients listed in `middlewareByClient` are handled here; all others
 * fall through to the existing shim-based instrumentation. This eliminates
 * the need for separate subscriber configs per AWS service package — a single
 * hook on `Client.send` covers every service, since all AWS SDK v3 clients
 * extend `@smithy/smithy-client.Client`.
 */
module.exports = class SmithyClientSendSubscriber extends Subscriber {
  constructor({ agent, logger }) {
    super({ agent, logger, channelName: 'nr_send', packageName: '@smithy/smithy-client' })
    this.events = ['end', 'asyncEnd']
    this.propagateContext = true
    this.callback = -1
  }

  handler(data, ctx) {
    const { self: client } = data
    const clientName = client.constructor.name.replace(/Client$/, '')

    // Only handle clients that have subscriber-based middleware.
    // Other clients (SNS, SQS, DynamoDB, Lambda, etc.) are still handled
    // by the shim-based instrumentation in lib/instrumentation/aws-sdk/v3/smithy-client.js.
    const middlewares = middlewareByClient[clientName]
    if (!middlewares) {
      return super.handler(data, ctx)
    }
    this.logger.trace('Sending with client %s', clientName)

    // Only attach middleware to a client instance once.
    // The symbol guard is on the client, not the subscriber,
    // because each client instance needs its own registration.
    if (!client[MIDDLEWARE]) {
      client[MIDDLEWARE] = true
      const config = client.config

      client.middlewareStack.add(
        (next) => this.headerMiddleware(config, next),
        { name: 'NewRelicHeader', step: 'finalizeRequest', priority: 'low', override: true }
      )

      client.middlewareStack.add(
        (next, context) => this.attrMiddleware(config, next, context),
        { name: 'NewRelicDeserialize', step: 'deserialize', priority: 'low', override: true }
      )

      // Register service-specific middleware based on client name,
      // mirroring the old middlewareByClient dispatch in smithy-client.js
      for (const mw of middlewares) {
        this.logger.trace('Registering middleware %s for %s', mw.config.name, clientName)
        const shouldRegister = (mw.init && mw.init(this, data)) || !mw.init
        if (shouldRegister) {
          client.middlewareStack.add(
            (next, context) => mw.middleware(this, config, next, context),
            mw.config
          )
        }
      }
    }

    return super.handler(data, ctx)
  }

  /**
   * Middleware that adds the x-new-relic-disable-dt header to outgoing
   * AWS requests. This tells the agent's http-outbound instrumentation
   * not to add DT headers to these requests.
   *
   * @param {object} config AWS client configuration
   * @param {Function} next next middleware function
   * @returns {Function} wrapped middleware
   */
  headerMiddleware(config, next) {
    return async function wrappedHeaderMw(args) {
      args.request.headers['x-new-relic-disable-dt'] = 'true'
      return await next(args)
    }
  }

  /**
   * Middleware that adds aws.* segment attributes from the AWS response.
   * Runs in the deserialize step so the response headers are available.
   *
   * @param {object} config AWS client configuration
   * @param {Function} next next middleware function
   * @param {object} context AWS command context (includes commandName)
   * @returns {Function} wrapped middleware
   */
  attrMiddleware(config, next, context) {
    const { agent, logger } = this
    return async function wrappedAttrMw(args) {
      let region
      try {
        region = await config.region()
      } catch (err) {
        logger.debug(err, 'Failed to get the AWS region')
      }

      const result = await next(args)

      try {
        // TODO: just pass in ctx?
        const segment = agent.tracer.getContext()?.segment
        if (segment) {
          const { response } = result
          segment.addAttribute('aws.operation', context.commandName || UNKNOWN)
          segment.addAttribute('aws.requestId', response.headers['x-amzn-requestid'] || UNKNOWN)
          segment.addAttribute('aws.service', config.serviceId || UNKNOWN)
          segment.addAttribute('aws.region', region || UNKNOWN)
        }
      } catch (err) {
        logger.debug(err, 'Failed to add AWS attributes to segment')
      }

      return result
    }
  }
}
