/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const Transaction = require('#agentlib/transaction/index.js')
const { DESTINATIONS: DESTS } = Transaction

module.exports = class AzureHandler {
  constructor(subscriber) {
    this.subscriber = subscriber
    this.agent = subscriber.agent
  }

  handleColdStart(transaction) {
    if (this.subscriber.coldStart === true) {
      transaction.trace.attributes.addAttribute(DESTS.TRANS_COMMON, 'faas.coldStart', true)
      this.subscriber.coldStart = false
    }
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
      this.subscriber.subscriptionId,
      '/resourceGroups/',
      this.subscriber.resourceGroup,
      '/providers/Microsoft.Web/sites/',
      this.subscriber.azureFunctionAppName,
      '/functions/',
      functionContext.functionName
    ].join('')
  }
}
