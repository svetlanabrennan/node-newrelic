/*
 * Copyright 2025 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const Subscriber = require('./base')
const { ALL, DB } = require('../metrics/names')
const { queryParser } = require('../../lib/db/query-parsers/elasticsearch')
const recordQueryMetrics = require('../../lib/metrics/recorders/database')
const ParsedStatement = require('../../lib/db/parsed-statement')
const { captureInstanceAttributes } = require('../../lib/shim/datastore-shim')

class ElasticsearchSubscriber extends Subscriber {
  constructor(agent) {
    super(agent, '@elastic/elasticsearch:nr_request')
    this.events = ['end']
    this._metrics = {
      PREFIX: 'ElasticSearch',
      STATEMENT: `${DB.STATEMENT}/ElasticSearch/`,
      ALL: `${DB.PREFIX}ElasticSearch/${ALL}`
    }
  }

  handler(data) {
    const { self, arguments: args } = data

    const connectionPool = self.connectionPool.connections[0]
    const host = connectionPool.url.host.split(':')
    const port = connectionPool.url.port || host?.[1]

    const ctx = this._agent.tracer.getContext()

    if (ctx?.transaction) {
      const query = JSON.stringify(args?.[0])
      const parsed = queryParser(query)

      const queryRecorded =
        this._agent.config.transaction_tracer.record_sql === 'raw' ||
        this._agent.config.transaction_tracer.record_sql === 'obfuscated'

      const parsedStatement = new ParsedStatement(
        'ElasticSearch',
        parsed.operation,
        parsed.collection,
        queryRecorded ? parsed.query : null
      )
      const name = (parsed.collection || 'other') + '/' + parsed.operation

      const segment = this._agent.tracer.createSegment({
        name: this._metrics.STATEMENT + name,
        parent: ctx.segment,
        query: JSON.stringify(args?.[0]),
        transaction: ctx.transaction,
        recorder: recordQueryMetrics.bind(parsedStatement)
      })

      segment.addAttribute('product', 'ElasticSearch')
      const newCtx = ctx.enterSegment({ segment })
      captureInstanceAttributes(host[0], port, 'ElasticSearch', segment, this._agent.config, 'ElasticSearch')

      return newCtx
    }
  }
}

module.exports = ElasticsearchSubscriber
