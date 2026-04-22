/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const AzureFunctionsSubscriber = require('./base')
const Transaction = require('#agentlib/transaction/index.js')
const recordWeb = require('#agentlib/metrics/recorders/http.js')
const { Transform } = require('node:stream')

module.exports = class AzureFunctionsHttpMethodsSubscriber extends AzureFunctionsSubscriber {
  constructor({ agent, logger, channelName = 'nr_azureHttpMethods' }) {
    super({ agent, logger, channelName })
  }

  handler(data, ctx) {
    if (this.missingEnvVars) {
      return ctx
    }

    this.registerLogHook()

    const args = data.arguments

    // If the app doesn't need an options object, the user can pass the
    // handler function as the second argument
    // (e.g. `app.get('name', handler)`).
    // See https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node?tabs=javascript%2Cwindows%2Cazure-cli&pivots=nodejs-model-v4#registering-a-function
    const originalHandler = this.extractHandler(args)

    const self = this
    args[1].handler = async function wrappedHandler(...handlerArgs) {
      const ctx = self.agent.tracer.getContext()
      if (ctx.transaction != null) {
        // If a transaction already exists, we run the function under that
        // transaction.
        return originalHandler.apply(this, handlerArgs)
      }
      const [request, context] = handlerArgs

      const newCtx = self.#createTransaction(request, context, ctx)
      const transaction = newCtx.transaction

      // Run everything within the bound context so that tracer.getSegment()
      // returns the correct segment (needed by initializeWeb/finalizeWeb).
      return self.agent.tracer.bindFunction(async () => {
        self.#initializeWeb(transaction, request)
        self.addFaasAttributes(transaction, context)

        const result = await self.agent.tracer.bindFunction(originalHandler, newCtx)(...handlerArgs)

        self.handleColdStart(transaction)

        transaction.finalizeWeb({ statusCode: result?.status, headers: result?.headers, end: false })
        if (result?.body instanceof Transform) {
          result.body.on('close', () => transaction.end())
        } else {
          transaction.end()
        }

        return result
      }, newCtx)()
    }

    return ctx
  }

  #createTransaction(request, context, currentCtx) {
    const transaction = new Transaction(this.agent)
    currentCtx = currentCtx.enterTransaction(transaction)

    transaction.setPartialName(`AzureFunction/${context.functionName}`)

    currentCtx = this.createSegment({
      name: request.url,
      recorder: recordWeb,
      ctx: currentCtx
    })

    transaction.baseSegment = currentCtx.segment

    return currentCtx
  }

  #initializeWeb(transaction, request) {
    const absoluteUrl = request.url
    const url = new URL(absoluteUrl)
    const transport = url.protocol === 'https:' ? 'HTTPS' : 'HTTP'
    const port = url.port || (transport === 'HTTPS' ? 443 : 80)
    transaction.initializeWeb({ absoluteUrl, method: request.method, port, headers: request.headers, transport })
  }
}
