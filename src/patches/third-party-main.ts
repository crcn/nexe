import { NexeCompiler } from '../compiler'
import { parse } from 'meriyah'
import { wrap, semverGt } from '../util'

function walkSome(node: any, visit: Function) {
  if (!node || typeof node.type !== 'string' || node._visited) {
    return false
  }
  visit(node)
  node._visited = true
  for (let childNode in node) {
    const child = node[childNode]
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        if (walkSome(child[i], visit)) {
          return true
        }
      }
    } else if (walkSome(child, visit)) {
      return true
    }
  }
  return false
}

export default async function main(compiler: NexeCompiler, next: () => Promise<void>) {
  let bootFile = 'lib/internal/bootstrap_node.js'
  const { version } = compiler.target

  if (version.startsWith('4.')) {
    bootFile = 'src/node.js'
  } else if (semverGt(version, '18.11.99')) {
    bootFile = 'lib/internal/process/pre_execution.js'
  } else if (semverGt(version, '11.99')) {
    bootFile = 'lib/internal/bootstrap/pre_execution.js'
  } else if (semverGt(version, '9.10.1')) {
    bootFile = 'lib/internal/bootstrap/node.js'
  }

  const file = await compiler.readFileAsync(bootFile),
    ast = parse(file.contents.toString(), {
      next: true,
      globalReturn: true,
      loc: true,
      specDeviation: true,
    }),
    location = { start: { line: 0 } }

  walkSome(ast, (node: any) => {
    if (!location.start.line && node.type === 'BlockStatement') {
      //Find the first block statement and mark the location
      Object.assign(location, node.loc)
      return true
    }
  })

  const fileLines = file.contents.toString().split('\n')
  if (semverGt(version, '18.16.99')) {
    await compiler.replaceInFileAsync(
      'lib/internal/modules/cjs/loader.js',
      "'use strict';",
      "'use strict';\n" + '{{ file("lib/fs/bootstrap.js") }}' + '\n'
    )
    fileLines.splice(location.start.line, 0, 'expandArgv1 = false;')
  } else {
    fileLines.splice(
      location.start.line,
      0,
      '{{ file("lib/fs/bootstrap.js") }}' +
        '\n' +
        (semverGt(version, '11.99') ? 'expandArgv1 = false;\n' : '')
    )
  }
  file.contents = fileLines.join('\n')

  if (semverGt(version, '11.99')) {
    if (semverGt(version, '12.17.99')) {
      await compiler.replaceInFileAsync(
        bootFile,
        'initializeFrozenIntrinsics();',
        'initializeFrozenIntrinsics();\n' + wrap('{{ file("lib/patches/boot-nexe.js") }}')
      )
    } else {
      await compiler.replaceInFileAsync(
        bootFile,
        'initializePolicy();',
        'initializePolicy();\n' + wrap('{{ file("lib/patches/boot-nexe.js") }}')
      )
    }
    await compiler.replaceInFileAsync(
      bootFile,
      'assert(!CJSLoader.hasLoadedAnyUserCJSModule)',
      '/*assert(!CJSLoader.hasLoadedAnyUserCJSModule)*/'
    )
    const { contents: nodeccContents } = await compiler.readFileAsync('src/node.cc')
    if (nodeccContents.includes('if (env->worker_context() != nullptr) {')) {
      await compiler.replaceInFileAsync(
        'src/node.cc',
        'if (env->worker_context() != nullptr) {',
        'if (env->worker_context() == nullptr) {\n' +
          '  return StartExecution(env, "internal/main/run_main_module"); } else {\n'
      )
    } else {
      await compiler.replaceInFileAsync(
        'src/node.cc',
        'MaybeLocal<Value> StartMainThreadExecution(Environment* env) {',
        'MaybeLocal<Value> StartMainThreadExecution(Environment* env) {\n' +
          '  return StartExecution(env, "internal/main/run_main_module");\n'
      )
    }
  } else {
    await compiler.setFileContentsAsync(
      'lib/_third_party_main.js',
      '{{ file("lib/patches/boot-nexe.js") }}'
    )
  }
  return next()
}
