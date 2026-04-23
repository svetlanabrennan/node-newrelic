/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const Subscriber = require('../base')
const Transaction = require('#agentlib/transaction/index.js')
const recordWeb = require('#agentlib/metrics/recorders/http.js')
const backgroundRecorder = require('#agentlib/metrics/recorders/other.js')
const { Transform } = require('node:stream')
const { DESTINATIONS: DESTS, TYPES } = Transaction

module.exports = class AzureFunctionsSubscriber extends Subscriber {
  constructor({ agent, logger }) {
    super({ agent, logger, channelName: 'nr_generic', packageName: '@azure/functions' })
    this.requireActiveTx = false
    this.coldStart = true
    this.logHookRegistered = false
  }

  handler(data, ctx) {
    if (this.missingEnvVars) {
      this.logger.warn(
        {
          data: {
            expectedVars: ['WEBSITE_OWNER_NAME', 'WEBSITE_RESOURCE_GROUP', 'WEBSITE_SITE_NAME'],
            found: { WEBSITE_OWNER_NAME: this.subscriptionId, WEBSITE_RESOURCE_GROUP: this.resourceGroup, WEBSITE_SITE_NAME: this.azureFunctionAppName }
          }
        },
        'could not initialize azure functions instrumentation due to missing environment variables'
      )
      return ctx
    }

    const { arguments: args } = data
    const [, options] = args
    const self = this
    const originalHandler = options.handler

    args[1].handler = async function wrappedHandler(...handlerArgs) {
      if (options?.return?.type === 'http') {
        return self.httpHandler({ thisArg: this, handlerArgs, originalHandler })
      } else {
        return self.backgroundHandler({ thisArg: this, originalHandler, handlerArgs })
      }
    }
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

  #createHttpTransaction(request, context, currentCtx) {
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
    currentCtx = this.createSegment({
      name: `${methodName}-trigger`,
      recorder: backgroundRecorder,
      ctx: currentCtx
    })

    transaction.baseSegment = currentCtx.segment

    return currentCtx
  }

  get missingEnvVars() {
    return !this.subscriptionId || !this.resourceGroup || !this.azureFunctionAppName
  }

  get subscriptionId() {
    if (!process.env.WEBSITE_OWNER_NAME) {
      return null
    }

    return process.env.WEBSITE_OWNER_NAME?.split('+').shift()
  }

  get resourceGroup() {
    const { WEBSITE_RESOURCE_GROUP, WEBSITE_OWNER_NAME } = process.env
    if (!WEBSITE_RESOURCE_GROUP && WEBSITE_OWNER_NAME) {
      return WEBSITE_OWNER_NAME.split('+').pop().split('-Linux').shift()
    }

    return WEBSITE_RESOURCE_GROUP
  }

  get azureFunctionAppName() {
    const { WEBSITE_SITE_NAME } = process.env
    return WEBSITE_SITE_NAME
  }

  addFaasAttributes(transaction, functionContext) {
    transaction.trace.attributes.addAttribute(
      DESTS.TRANS_COMMON,
      'faas.invocation_id',
      functionContext.invocationId ?? 'unknown'
    )
    transaction.trace.attributes.addAttribute(
      DESTS.TRANS_COMMON,
      'faas.name',
      functionContext.functionName ?? 'unknown'
    )
    transaction.trace.attributes.addAttribute(
      DESTS.TRANS_COMMON,
      'faas.trigger',
      this.mapTriggerType(functionContext)
    )
    transaction.trace.attributes.addAttribute(
      DESTS.TRANS_COMMON,
      'cloud.resource_id',
      this.buildCloudResourceId(functionContext)
    )
  }

  mapTriggerType(functionContext) {
    const input = functionContext.options?.trigger?.type

    // Input types are found at:
    // https://github.com/Azure/azure-functions-nodejs-library/blob/138c021/src/trigger.ts
    // https://learn.microsoft.com/en-us/azure/azure-functions/functions-triggers-bindings?tabs=isolated-process%2Cnode-v4%2Cpython-v2&pivots=programming-language-javascript#supported-bindings
    switch (input) {
      case 'httpTrigger': {
        return 'http'
      }

      case 'timerTrigger': {
        return 'timer'
      }

      case 'blobTrigger':
      case 'cosmosDBTrigger':
      case 'daprBindingTrigger':
      case 'mysqlTrigger':
      case 'queueTrigger':
      case 'sqlTrigger': {
        return 'datasource'
      }

      case 'daprTopicTrigger':
      case 'eventGridTrigger':
      case 'eventHubTrigger':
      case 'kafkaTrigger':
      case 'rabbitMQTrigger':
      case 'redisListTrigger':
      case 'redisPubSubTrigger':
      case 'redisStreamTrigger':
      case 'serviceBusTrigger':
      case 'signalRTrigger':
      case 'webPubSubTrigger': {
        return 'pubsub'
      }

      default: {
        return 'other'
      }
    }
  }

  buildCloudResourceId(functionContext) {
    return [
      '/subscriptions/',
      this.subscriptionId,
      '/resourceGroups/',
      this.resourceGroup,
      '/providers/Microsoft.Web/sites/',
      this.azureFunctionAppName,
      '/functions/',
      functionContext.functionName
    ].join('')
  }

  handleColdStart(transaction) {
    if (this.coldStart === true) {
      transaction.trace.attributes.addAttribute(DESTS.TRANS_COMMON, 'faas.coldStart', true)
      this.coldStart = false
    }
  }
}
