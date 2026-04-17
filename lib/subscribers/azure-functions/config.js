/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict'

const modName = '@azure/functions'
const filePath = 'dist/azure-functions.js'
const versionRange = '>=4.7.0'

const httpMethods = {
  path: './azure-functions/http-methods.js',
  instrumentations: ['http', 'get', 'put', 'post', 'patch', 'deleteRequest'].map((methodName) => {
    return {
      channelName: 'nr_azureHttpMethods',
      module: { name: modName, versionRange, filePath },
      functionQuery: {
        functionName: methodName,
        kind: 'Sync'
      }
    }
  })
}

const backgroundMethods = {
  path: './azure-functions/background-methods.js',
  instrumentations: [
    'cosmosDB', 'eventGrid', 'eventHub', 'mySql',
    'serviceBusQueue', 'serviceBusTopic', 'sql',
    'storageBlob', 'storageQueue', 'timer', 'warmup', 'webPubSub'
  ].map((methodName) => {
    return {
      channelName: 'nr_azureBackgroundMethods',
      module: { name: modName, versionRange, filePath },
      functionQuery: {
        functionName: methodName,
        kind: 'Sync'
      }
    }
  })
}

module.exports = {
  [modName]: [
    httpMethods,
    backgroundMethods
  ]
}
