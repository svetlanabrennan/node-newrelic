/*
 * Copyright 2025 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const { Attributes } = require('#agentlib/attributes.js')
const { DESTINATIONS } = require('#agentlib/config/attribute-filter.js')
const normalizeTimestamp = require('#agentlib/otel/normalize-timestamp.js')

/**
 * This keeps a static list of attributes that are used by
 * one or more entity relationship rules to synthesize an entity relationship.
 */
const ENTITY_RELATIONSHIP_ATTRIBUTES = [
  'cloud.account.id',
  'cloud.platform',
  'cloud.region',
  'cloud.resource_id',
  'db.instance',
  'db.system',
  'http.url',
  'messaging.destination.name',
  'messaging.system',
  'peer.hostname',
  'server.address',
  'server.port',
  'span.kind',
]

const ERROR_ATTRIBUTES = [
  'error.class',
  'error.message',
  'error.expected'
]

/**
 * All the intrinsic attributes for span events, regardless of kind.
 */
class SpanIntrinsics {
  constructor() {
    this.type = 'Span'
    this.traceId = null
    this.guid = null
    this.parentId = null
    this.transactionId = null
    this.sampled = null
    this.priority = null
    this.name = null
    this.category = CATEGORIES.GENERIC
    this.component = null
    this.timestamp = null
    this.duration = null
    this['nr.entryPoint'] = null
    this['nr.pg'] = null
    this['nr.durations'] = null
    this['nr.ids'] = null
    this['span.kind'] = null
    this.trustedParentId = null
    this.tracingVendors = null
  }
}

/**
 * General span event class.
 *
 * Do not construct directly, instead use one of the static `from*` methods such
 * as `SpanEvent.fromSegment`.
 *
 * @private
 * @class
 *
 * @property {Attributes} userAttributes User attributes that were added to
 * the event before it was stored.
 * @property {Attributes} agentAttributes Agent attributes that the New Relic
 * agent has determined need to be present.
 * @property {object} intrinsics The core attributes that must be present
 * for the backend system to recognize this data as a span event.
 */
class SpanEvent {
  /**
   * Creates a new span event instance.
   *
   * @param {object} params Data required for creating the object.
   * @param {object} params.event The OpenTelemetry span event object.
   * See https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk-node.node.TimedEvent.html
   * @param {object} params.spanContext The OpenTelemetry span context object.
   */
  constructor({ event, spanContext }) {
    this.userAttributes = new Attributes({ scope: Attributes.SCOPE_SEGMENT })
    this.agentAttributes = new Attributes({ scope: Attributes.SCOPE_SEGMENT })
    this.intrinsics = Object.create(null)

    const timestamp = normalizeTimestamp(event.time)

    this.intrinsics.type = 'SpanEvent'
    this.intrinsics.timestamp = timestamp
    this.intrinsics['span.id'] = spanContext.spanId
    this.intrinsics['trace.id'] = spanContext.traceId
    this.intrinsics.name = event.name

    for (const [key, value] of Object.entries(event.attributes)) {
      this.agentAttributes.addAttribute(DESTINATIONS.TRANS_SEGMENT, key, value)
    }
  }

  get [Symbol.toStringTag]() { return 'SpanEvent' }

  getIntrinsicAttributes() {
    return this.intrinsics
  }

  addIntrinsics({ segment, spanContext, transaction, parentId, isRoot, isEntry }) {
    for (const [key, value] of Object.entries(spanContext.intrinsicAttributes)) {
      this.addIntrinsicAttribute(key, value)
    }

    this.addIntrinsicAttribute('traceId', transaction.traceId)
    this.addIntrinsicAttribute('transactionId', transaction.id)
    this.addIntrinsicAttribute('sampled', transaction.sampled)
    this.addIntrinsicAttribute('priority', transaction.priority)
    this.addIntrinsicAttribute('name', segment.name)
    this.addIntrinsicAttribute('guid', segment.id)
    this.addIntrinsicAttribute('parentId', parentId)

    if (isRoot) {
      this.addIntrinsicAttribute('trustedParentId', transaction.traceContext.trustedParentId)
      if (transaction.traceContext.tracingVendors) {
        this.addIntrinsicAttribute('tracingVendors', transaction.traceContext.tracingVendors)
      }
    }

    // Only set this if it will be `true`. Must be `null` otherwise.
    if (isEntry) {
      this.addIntrinsicAttribute('nr.entryPoint', true)
    }

    // Timestamp in milliseconds, duration in seconds. Yay consistency!
    this.addIntrinsicAttribute('timestamp', segment.timer.start)
    this.addIntrinsicAttribute('duration', segment.timer.getDurationInMillis() / 1000)
  }

  addIntrinsicAttribute(key, value) {
    this.intrinsics[key] = value
  }

  static get CATEGORIES() {
    return CATEGORIES
  }

  static get DatastoreSpanEvent() {
    return DatastoreSpanEvent
  }

  static get HttpSpanEvent() {
    return HttpSpanEvent
  }

  /**
   * Check if span is exit span
   * @returns {boolean} if span is external http, db, or msg producer(aka exit span)
   */
  get isExitSpan() {
    if (this._isExitSpan === undefined) {
      const name = this.intrinsics.name
      this._isExitSpan = REGEXS.CLIENT.EXTERNAL.test(name) || REGEXS.CLIENT.DATASTORE.test(name) || REGEXS.PRODUCER.test(name)
    }

    return this._isExitSpan
  }

  /**
   * Check if span is LLM span
   * @returns {boolean} if span name starts with `Llm/`
   */
  get isLlmSpan() {
    if (this._isLlmSpan === undefined) {
      this._isLlmSpan = this.intrinsics.name?.startsWith('Llm/') || false
    }

    return this._isLlmSpan
  }

  /**
   * Creates an object of only error attrs
   * @returns {object} error attrs
   */
  get errorAttrs() {
    if (this._errorAttrs === undefined) {
      this._errorAttrs = Object.create(null)
      for (const key of ERROR_ATTRIBUTES) {
        if (key in this.attributes) {
          this._errorAttrs[key] = this.attributes[key]
        }
      }
    }
    return this._errorAttrs
  }

  /**
   * Checks if any of the attributes are error attributes
   * @returns {boolean} span contains error attributes
   */
  get hasErrorAttrs() {
    if (this._hasErrorAttrs === undefined) {
      for (const key of ERROR_ATTRIBUTES) {
        if (key in this.attributes) {
          this._hasErrorAttrs = true
          return this._hasErrorAttrs
        }
      }
      this._hasErrorAttrs = false
    }

    return this._hasErrorAttrs
  }

  /**
   * Creates an object of only entity relationship attrs
   * @returns {object} entity relationship attrs
   */
  get entityRelationshipAttrs() {
    if (this._entityAttrs === undefined) {
      this._entityAttrs = Object.create(null)
      for (const key of ENTITY_RELATIONSHIP_ATTRIBUTES) {
        if (key in this.attributes) {
          this._entityAttrs[key] = this.attributes[key]
        }
      }
    }
    return this._entityAttrs
  }

  /**
   * Checks if any of the attributes are entity relationship attributes
   * @returns {boolean} span contains entity relationship attributes
   */
  get hasEntityRelationshipAttrs() {
    if (this._hasEntityAttrs === undefined) {
      for (const key of ENTITY_RELATIONSHIP_ATTRIBUTES) {
        if (key in this.attributes) {
          this._hasEntityAttrs = true
          return this._hasEntityAttrs
        }
      }
      this._hasEntityAttrs = false
    }

    return this._hasEntityAttrs
  }

  /**
   * Filters attributes to only keep entity relationship and `error.*` attributes
   * Note: This is only run after it is determined that there are entity relationship attributes
   * @returns {object} only entity relationship and `error.*` attributes
   */
  get filteredAttrs() {
    if (this._filteredAttrs === undefined) {
      this._filteredAttrs = { ...this.entityRelationshipAttrs, ...this.errorAttrs }
    }

    return this._filteredAttrs
  }

  /**
   * Compares entity relationship attributes with current span and first exit span in `partialTrace.compactSpanGroups`
   * @param {SpanEvent} firstSpan first exit span in a given `partialTrace.compactSpanGroups`
   * @returns {boolean} If current span has the same key/values as first exit span it returns true, otherwise false
   */
  hasSameEntityAttrs(firstSpan) {
    const firstAttrs = firstSpan.entityRelationshipAttrs
    const currentAttrs = this.entityRelationshipAttrs

    // check if all values from firstAttrs match in currentAttrs
    for (const key in firstAttrs) {
      if (firstAttrs[key] !== currentAttrs[key]) {
        return false
      }
    }

    // make sure currentAttrs doesn't have extra keys
    for (const key in currentAttrs) {
      if (!(key in firstAttrs)) {
        return false
      }
    }

    return true
  }

  /**
   * Tests if an exit span has entity relationship attributes as another exit span
   * @param {PartialTrace} partialTrace of spans
   * @returns {Array|null} if exit span has same entity relationship attributes it returns the array otherwise null
   */
  getEntityGroup(partialTrace) {
    let entityGroup = null
    for (const group of Object.values(partialTrace.compactSpanGroups)) {
      const firstSpanInGroup = group.at(0)
      if (this.hasSameEntityAttrs(firstSpanInGroup)) {
        entityGroup = group
        break
      }
    }
    return entityGroup
  }

  /**
   * Drops span or filters attributes based on partial trace rules for a given mode.
   * The rules are as such:
   *  - If an entry point span, return span untouched
   *  - If an LLM span, return span untouched
   *  - If not an exit span, return null(drop span)
   *  - If mode is 'reduced' and there are entity relationship attributes, return span untouched otherwise return null(drop span)
   *  - If mode is 'essential' and there are entity relationship attributes or error attributes, return span with only those attributes, drop custom attributes otherwise return null(drop span)
   *  - If mode is 'compact' and there are entity relationship attributes or error attributes and it's the first span to talk to an entity, return span with only those attributes and drop custom attributes. If not, store span in `partialTrace.reducedSpanGroups`
   *  this is used to calculate `nr.durations`, `nr.ids` and store the last error
   *
   *  @param {object} params to function
   *  @param {boolean} params.isEntry flag indicating span is entry point span
   *  @param {PartialTrace} params.partialTrace partial trace to do its processing
   *  @returns {SpanEvent|null} the span after applying the rules, or null if dropped
   */
  applyPartialTraceRules({ isEntry, partialTrace }) {
    // in essential and compact mode - we need to remove the non intrinsic attributes from span links early in this process because there can be an entry span,
    // llm span exit span or span with no entity relationship attributes can have non intrinsics on it.
    if (partialTrace.type !== PARTIAL_TYPES.REDUCED) {
      for (const link of this.spanLinks) {
        link.removeNonIntrinsicsAttrs()
      }
    }

    if (isEntry) {
      this.addIntrinsicAttribute('nr.pg', true)
      logger.trace('Span %s is an entry point, keeping span unchanged.', this.intrinsics.name)
      return this
    }

    if (this.isLlmSpan) {
      logger.trace('Span %s is an LLM span, keeping span unchanged.', this.intrinsics.name)
      return this
    }

    if (!this.isExitSpan) {
      logger.trace('Span %s is not an exit span and trace is partial granularity type: %s.', this.intrinsics.name, partialTrace.type)
      return null
    }

    // partial granularity type rules layer on top of each other.
    // running all logic assumes `compact` type
    // it will return modified span once specific checks are done for a given type
    if (!this.hasEntityRelationshipAttrs) {
      logger.trace('Span %s does not contain any entity relationship attributes %j and trace is partial granularity type: %s, dropping span.', this.intrinsics.name, this.attributes, partialTrace.type)
      return null
    }

    if (partialTrace.type === PARTIAL_TYPES.REDUCED) {
      logger.trace('Span %s contains entity relationship attributes and trace is partial granularity type: %s, keeping span unchanged.', this.intrinsics.name, partialTrace.type)
      return this
    }

    this.attributes = this.filteredAttrs
    this.customAttributes = Object.create(null)

    if (partialTrace.type === PARTIAL_TYPES.ESSENTIAL) {
      logger.trace('Span %s contains entity relationship attributes and trace is partial granularity type: %s, only keeping entity relationship attributes and removing custom attributes.', this.intrinsics.name, partialTrace.type)
      return this
    }

    const entityGroup = this.getEntityGroup(partialTrace)
    if (entityGroup) {
      entityGroup.push(this)
      logger.trace('Span %s has the same entity relationship attributes and trace is partial type %s, dropping span.', this.intrinsics.name, partialTrace.type)
      return null
    }

    partialTrace.compactSpanGroups[this.id] = [this]
    logger.trace('Span %s has unique entity relationship attributes %j and trace is partial type: %s, keeping span.', this.intrinsics.name, this.filteredAttrs, partialTrace.type)
    return this
  }

  static createSpan({ segment, attributes, customAttributes }) {
    let span = null
    if (HttpSpanEvent.testSegment(segment)) {
      span = new HttpSpanEvent(attributes, customAttributes)
    } else if (DatastoreSpanEvent.testSegment(segment)) {
      span = new DatastoreSpanEvent(attributes, customAttributes)
    } else {
      span = new SpanEvent(attributes, customAttributes)
    }
    span.spanLinks = segment.spanLinks ?? []
    span.timedEvents = segment.timedEvents ?? []
    return span
  }

  /**
   * Constructs a `SpanEvent` from the given segment.
   *
   * The constructed span event will contain extra data depending on the
   * category of the segment.
   *
   * @param {object} params params object
   * @param {TraceSegment} params.segment segment to turn into a span event.
   * @param {Transaction} params.transaction active transaction
   * @param {?string} [params.parentId] ID of the segment's parent.
   * @param {boolean} [params.isRoot] if segment is root segment; defaults to `false`
   * @param {boolean} [params.isEntry] if segment is entry point; defaults to `false`
   * @returns {SpanEvent} The constructed event.
   */
  static fromSegment({ segment, transaction, parentId = null, isRoot = false, isEntry = false }) {
    const spanContext = segment.getSpanContext()

    // Since segments already hold span agent attributes and we want to leverage
    // filtering, we add to the segment attributes prior to processing.
    if (spanContext.hasError && !transaction.hasIgnoredErrorStatusCode()) {
      const details = spanContext.errorDetails
      segment.addSpanAttribute('error.message', details.message)
      segment.addSpanAttribute('error.class', details.type)
      if (details.expected) {
        segment.addSpanAttribute('error.expected', details.expected)
      }
    }

    const attributes = segment.attributes.get(DESTINATIONS.SPAN_EVENT)
    const customAttributes = spanContext.customAttributes.get(DESTINATIONS.SPAN_EVENT)
    const span = SpanEvent.createSpan({ segment, attributes, customAttributes })
    span.addIntrinsics({ segment, spanContext, transaction, parentId, isRoot, isEntry })

    addSpanKind({ segment, span })
    return span
  }

  toJSON() {
    return [
      filterNulls(this.intrinsics),
      filterNulls(this.userAttributes.get(DESTINATIONS.TRANS_SEGMENT)),
      filterNulls(this.agentAttributes.get(DESTINATIONS.TRANS_SEGMENT))
    ]
  }
}

function filterNulls(inputObj) {
  return Object.fromEntries(
    Object
      .entries(inputObj)
      .filter(([, value]) => value != null)
  )
}

module.exports = SpanEvent
