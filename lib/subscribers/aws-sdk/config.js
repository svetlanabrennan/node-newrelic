/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

const sendConfig = {
  path: './aws-sdk/send.js',
  instrumentations: [
    // CJS
    {
      channelName: 'nr_send',
      module: { name: '@smithy/smithy-client', versionRange: '>=4.0.0', filePath: 'dist-cjs/index.js' },
      functionQuery: {
        className: 'Client',
        methodName: 'send',
        kind: 'Sync'
      }
    },
    {
      channelName: 'nr_send',
      module: { name: '@smithy/smithy-client', versionRange: '>=1.0.0 <4.0.0', filePath: 'dist-cjs/index.js' },
      functionQuery: {
        className: '_Client',
        methodName: 'send',
        kind: 'Sync'
      }
    },
    // ESM
    {
      channelName: 'nr_send',
      module: { name: '@smithy/smithy-client', versionRange: '>=4.0.0', filePath: 'dist-es/index.js' },
      functionQuery: {
        className: 'Client',
        methodName: 'send',
        kind: 'Sync'
      }
    },
    {
      channelName: 'nr_send',
      module: { name: '@smithy/smithy-client', versionRange: '>=1.0.0 <4.0.0', filePath: 'dist-es/index.js' },
      functionQuery: {
        className: '_Client',
        methodName: 'send',
        kind: 'Sync'
      }
    }
  ]
}

module.exports = {
  '@smithy/smithy-client':
    [
      sendConfig
    ]
}
