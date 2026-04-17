/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const AzureFunctionsSubscriber = require('./base')
const Transaction = require('#agentlib/transaction/index.js')
const backgroundRecorder = require('#agentlib/metrics/recorders/other.js')

const { TYPES } = Transaction

module.exports = class AzureFunctionsBackgroundMethodsSubscriber extends AzureFunctionsSubscriber {
  constructor({ agent, logger, channelName = 'nr_azureBackgroundMethods' }) {
    super({ agent, logger, channelName })
  }

  handler(data, ctx) {
    if (this.missingEnvVars) {
      return ctx
    }

    const args = data.arguments
    const originalHandler = this.extractHandler(args)

    const self = this
    args[1].handler = async function wrappedHandler(...handlerArgs) {
      const ctx = self.agent.tracer.getContext()
      if (ctx.transaction != null) {
        return originalHandler.apply(this, handlerArgs)
      }
      const [, context] = handlerArgs

      const newCtx = self.#createTransaction(context, ctx)
      const transaction = newCtx.transaction

      return self.agent.tracer.bindFunction(async () => {
        self.addFaasAttributes(transaction, context)

        const result = await self.agent.tracer.bindFunction(originalHandler, newCtx)(...handlerArgs)

        self.handleColdStart(transaction)

        transaction.end()
        return result
      }, newCtx)()
    }

    return ctx
  }

  #createTransaction(context, currentCtx) {
    const transaction = new Transaction(this.agent)
    currentCtx = currentCtx.enterTransaction(transaction)

    transaction.type = TYPES.BG
    transaction.setPartialName(`AzureFunction/${context.functionName}`)

    const triggerType = context.options?.trigger?.type ?? 'unknown'
    const methodName = triggerType.replace(/Trigger$/, '')
    currentCtx = this.createSegment({
      name: `${methodName}-trigger`,
      recorder: backgroundRecorder,
      ctx: currentCtx
    })

    transaction.baseSegment = currentCtx.segment

    return currentCtx
  }
}
