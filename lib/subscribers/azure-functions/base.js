/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const Subscriber = require('../base')
const Transaction = require('#agentlib/transaction/index.js')

const { DESTINATIONS: DESTS } = Transaction

const {
  WEBSITE_OWNER_NAME,
  WEBSITE_RESOURCE_GROUP,
  WEBSITE_SITE_NAME
} = process.env
const SUBSCRIPTION_ID = WEBSITE_OWNER_NAME?.split('+').shift()
const RESOURCE_GROUP_NAME = WEBSITE_RESOURCE_GROUP ?? WEBSITE_OWNER_NAME?.split('+').pop().split('-Linux').shift()
const AZURE_FUNCTION_APP_NAME = WEBSITE_SITE_NAME

let coldStart = true

module.exports = class AzureFunctionsSubscriber extends Subscriber {
  constructor({ agent, logger, channelName }) {
    super({ agent, logger, channelName, packageName: '@azure/functions' })

    this.missingEnvVars = false

    if (!SUBSCRIPTION_ID || !RESOURCE_GROUP_NAME || !AZURE_FUNCTION_APP_NAME) {
      logger.warn(
        {
          data: {
            expectedVars: ['WEBSITE_OWNER_NAME', 'WEBSITE_RESOURCE_GROUP', 'WEBSITE_SITE_NAME'],
            found: { WEBSITE_OWNER_NAME, WEBSITE_RESOURCE_GROUP, WEBSITE_SITE_NAME }
          },
        },
        'could not initialize azure functions instrumentation due to missing environment variables'
      )
      this.missingEnvVars = true
    }
  }

  extractHandler(args) {
    let originalHandler
    if (typeof args[1] === 'function') {
      originalHandler = args[1]
      args[1] = { handler: originalHandler }
    } else {
      originalHandler = args[1].handler
    }
    return originalHandler
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
      SUBSCRIPTION_ID,
      '/resourceGroups/',
      RESOURCE_GROUP_NAME,
      '/providers/Microsoft.Web/sites/',
      AZURE_FUNCTION_APP_NAME,
      '/functions/',
      functionContext.functionName
    ].join('')
  }

  handleColdStart(transaction) {
    if (coldStart === true) {
      transaction.trace.attributes.addAttribute(DESTS.TRANS_COMMON, 'faas.coldStart', true)
      coldStart = false
    }
  }
}
