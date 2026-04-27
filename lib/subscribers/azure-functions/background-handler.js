/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const AzureHandler = require('#agentlib/subscribers/azure-functions/azure-handler-base.js')
const Transaction = require('#agentlib/transaction/index.js')
const backgroundRecorder = require('#agentlib/metrics/recorders/other.js')
const { TYPES } = Transaction

module.exports = class BackgroundHandler extends AzureHandler {
  constructor({ subscriber }) {
    super(subscriber)
  }

  async backgroundHandler({ thisArg, originalHandler, handlerArgs }) {
    const ctx = this.agent.tracer.getContext()
    if (ctx.transaction != null) {
      return originalHandler.apply(thisArg, handlerArgs)
    }
    const [, context] = handlerArgs

    const newCtx = this.#createBgTransaction(context, ctx)
    const transaction = newCtx.transaction

    this.addFaasAttributes(transaction, context)
    const result = await this.agent.tracer.bindFunction(originalHandler, newCtx).apply(thisArg, handlerArgs)
    this.handleColdStart(transaction)

    transaction.end()
    return result
  }

  #createBgTransaction(context, currentCtx) {
    const transaction = new Transaction(this.agent)
    currentCtx = currentCtx.enterTransaction(transaction)

    transaction.type = TYPES.BG
    transaction.setPartialName(`AzureFunction/${context.functionName}`)

    const triggerType = context.options?.trigger?.type ?? 'unknown'
    const methodName = triggerType.replace(/Trigger$/, '')
    currentCtx = this.subscriber.createSegment({
      name: `${methodName}-trigger`,
      recorder: backgroundRecorder,
      ctx: currentCtx
    })

    transaction.baseSegment = currentCtx.segment

    return currentCtx
  }
}
