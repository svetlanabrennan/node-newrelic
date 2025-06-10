/*
 * Copyright 2025 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'
const Subscriber = require('./base')
const { params: { DatastoreParameters } } = require('../shim/specs')
const recordOperationMetrics = require('../metrics/recorders/database-operation')
const logger = require('../logger').child({ component: 'instrumentationSubscriber' })
const urltils = require('../util/urltils')
const { ALL, DB } = require('../metrics/names')
const stringify = require('json-stringify-safe')

class IoRedisSubscriber extends Subscriber {
  constructor(agent) {
    super(agent, 'ioredis:nr_sendCommand')
    this.events = ['asyncEnd']
    this._metrics = {
      PREFIX: 'Redis',
      ALL: `${DB.PREFIX}Redis/${ALL}`
    }
  }

  handler(data) {
    const { self, arguments: args } = data
    const [command] = args
    const parameters = new DatastoreParameters({
      host: self.connector.options.host,
      port_path_or_id: self.connector.options.port
    })

    const keys = command.args
    if (keys && typeof keys !== 'function') {
      const src = Object.create(null)
      try {
        src.key = stringify(keys[0])
      } catch (err) {
        logger.debug(err, 'Failed to stringify ioredis key')
        src.key = '<unknown>'
      }
      urltils.copyParameters(src, parameters)
    }

    const ctx = this._agent.tracer.getContext()
    if (ctx?.transaction) {
      const name = `${DB.OPERATION}/Redis/${command.name}`
      const segment = this._agent.tracer.createSegment({
        name,
        parent: ctx.segment,
        recorder: recordOperationMetrics.bind(this),
        transaction: ctx.transaction
      })
      for (const [key, value] of Object.entries(parameters)) {
        segment.addAttribute(key, value)
      }
      const newCtx = ctx.enterSegment({ segment })
      return newCtx
    }
  }
}

module.exports = IoRedisSubscriber
