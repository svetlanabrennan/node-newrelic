/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const AzureHandler = require('#agentlib/subscribers/azure-functions/azure-handler-base.js')
const Transaction = require('#agentlib/transaction/index.js')
const { Transform } = require('node:stream')
const recordWeb = require('#agentlib/metrics/recorders/http.js')

module.exports = class HttpHandler extends AzureHandler {
  constructor({ subscriber }) {
    super(subscriber)
  }

  async httpHandler({ thisArg, originalHandler, handlerArgs }) {
    const ctx = this.agent.tracer.getContext()
    if (ctx.transaction != null) {
      // If a transaction already exists, we run the function under that
      // transaction.
      return originalHandler.apply(thisArg, handlerArgs)
    }

    const [request, context] = handlerArgs

    const newCtx = this.#createHttpTransaction(request, context, ctx)
    const transaction = newCtx.transaction
    this.addFaasAttributes(transaction, context)
    const self = this
    function inContext() {
      self.#initializeWeb(transaction, request)
      return originalHandler.apply(this, arguments)
    }
    const result = await self.agent.tracer.bindFunction(inContext, newCtx).apply(thisArg, handlerArgs)
    this.handleColdStart(transaction)
    transaction.finalizeWeb({ statusCode: result?.status, headers: result?.headers, end: false })
    if (result?.body instanceof Transform) {
      result.body.on('close', () => transaction.end())
    } else {
      transaction.end()
    }
    return result
  }

  #initializeWeb(transaction, request) {
    const absoluteUrl = request.url
    const url = new URL(absoluteUrl)
    const transport = url.protocol === 'https:' ? 'HTTPS' : 'HTTP'
    const port = url.port || (transport === 'HTTPS' ? 443 : 80)
    transaction.initializeWeb({ absoluteUrl, method: request.method, port, headers: request.headers, transport })
  }

  #createHttpTransaction(request, context, currentCtx) {
    const transaction = new Transaction(this.agent)
    currentCtx = currentCtx.enterTransaction(transaction)

    transaction.setPartialName(`AzureFunction/${context.functionName}`)

    currentCtx = this.subscriber.createSegment({
      name: request.url,
      recorder: recordWeb,
      ctx: currentCtx
    })

    transaction.baseSegment = currentCtx.segment

    return currentCtx
  }
}
