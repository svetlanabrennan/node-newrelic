/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const Subscriber = require('../base')
const Transaction = require('#agentlib/transaction/index.js')
const {
  isApplicationLoggingEnabled,
  isLogForwardingEnabled,
  isMetricsEnabled,
  incrementLoggingLinesMetrics
} = require('#agentlib/util/application-logging.js')

const { DESTINATIONS: DESTS } = Transaction

// Azure Functions uses 'information' as the context level for context.log and
// context.info and uses 'warning' as the context level for context.warn.
// These map to the NR standard names that LOGGING.LEVELS recognizes ('info', 'warn').
const AZURE_TO_NR_LEVEL = {
  information: 'info',
  warning: 'warn'
}

const {
  WEBSITE_OWNER_NAME,
  WEBSITE_RESOURCE_GROUP,
  WEBSITE_SITE_NAME
} = process.env
const SUBSCRIPTION_ID = WEBSITE_OWNER_NAME?.split('+').shift()
const RESOURCE_GROUP_NAME = WEBSITE_RESOURCE_GROUP ?? WEBSITE_OWNER_NAME?.split('+').pop().split('-Linux').shift()
const AZURE_FUNCTION_APP_NAME = WEBSITE_SITE_NAME

let coldStart = true
let logHookRegistered = false

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

  registerLogHook(azureFunctionsModule) {
    if (logHookRegistered) {
      return
    }

    logHookRegistered = true

    if (!isApplicationLoggingEnabled(this.agent.config)) {
      this.logger.debug('Application logging not enabled. Not auto capturing logs from Azure Functions.')
      return
    }

    const agent = this.agent
    // eslint-disable-next-line n/no-missing-require
    const azureFunctions = azureFunctionsModule ?? require('@azure/functions')

    azureFunctions.app.hook?.log((context) => {
      const logLevel = AZURE_TO_NR_LEVEL[context.level] ?? context.level

      if (isLogForwardingEnabled(agent.config, agent)) {
        const meta = agent.getLinkingMetadata(true)

        const logData = {
          message: context.message,
          level: logLevel,
          timestamp: Date.now(),
          category: context.category,
          ...meta
        }

        agent.logs.add(logData)
      }

      if (isMetricsEnabled(agent.config)) {
        incrementLoggingLinesMetrics(logLevel, agent.metrics)
      }
    })
  }

  handleColdStart(transaction) {
    if (coldStart === true) {
      transaction.trace.attributes.addAttribute(DESTS.TRANS_COMMON, 'faas.coldStart', true)
      coldStart = false
    }
  }
}
