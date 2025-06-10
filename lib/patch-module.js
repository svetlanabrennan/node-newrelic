/*
 * Copyright 2025 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

const { create } = require('@apm-js-collab/code-transformer')
const Module = require('node:module')
const parse = require('module-details-from-path')
const transformers = new Map()
const getPackageVersion = require('./util/get-package-version')
const subscribers = require('./instrumentation-subscribers')

const origResolveFileName = Module._resolveFilename
const origCompile = Module.prototype._compile

function patch() {
  const instrumentator = create(subscribers)
  Module._resolveFilename = function wrappedResolveFileName() {
    const resolvedName = origResolveFileName.apply(this, arguments)
    const resolvedModule = parse(resolvedName)
    if (resolvedModule) {
      const version = getPackageVersion(resolvedModule.basedir, resolvedModule.name)
      const transformer = instrumentator.getTransformer(resolvedModule.name, version, resolvedModule.path)
      if (transformer) {
        transformers.set(resolvedName, transformer)
      }
    }
    return resolvedName
  }

  Module.prototype._compile = function wrappedCompile(content, filename) {
    if (transformers.has(filename)) {
      const transformer = transformers.get(filename)
      const transformedCode = transformer.transform(content, false)
      transformer.free()
      return origCompile.call(this, transformedCode, filename)
    }
    return origCompile.apply(this, arguments)
  }
}

function unpatch() {
  Module._resolveFilename = origResolveFileName
  Module.prototype._compile = origCompile
  transformers.clear()
}

module.exports = {
  patch,
  unpatch
}
