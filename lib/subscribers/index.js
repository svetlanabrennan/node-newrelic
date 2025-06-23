/*
 * Copyright 2025 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

const ElasticsearchSubscriber = require('./elasticsearch')
const IoRedisSubscriber = require('./ioredis')

module.exports = {
  IoRedisSubscriber,
  ElasticsearchSubscriber
}
