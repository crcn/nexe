'use strict'

const { resolve } = require('path')
const resolvePath = (path) => resolve(__dirname, '..', path)

async function compile() {
  const executableSuffix = require('os').platform().startsWith('win') ? '.exe' : ''
  const builtExecutablePath = require('path').join(process.env.NEXE_TMP, process.versions.node, `out/Release/node${executableSuffix}`)
  try {
    require('fs').unlinkSync(builtExecutablePath)
  } catch(e) {}
  const nexe = require('..')
  console.error('Building asset')
  return nexe.compile({
    loglevel: 'verbose',
    python: process.env.PYTHON || 'python',
    mangle: false,
    build: true,
    output: process.env.NEXE_ASSET || `nexe-asset${executableSuffix}`,
    input: resolvePath('test/asset-build-input.js'),
    configure: process.env.MUSL_BUILD ? ['--fully-static'] : [],
    temp: process.env.NEXE_TMP,
  })
}

if (!('MAKEFLAGS' in process.env)) {
  process.env.MAKEFLAGS = `-j${require('os').cpus().length + 1}`
}

compile()
