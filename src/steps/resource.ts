import { isDirectoryAsync, each } from '../util'
import * as globs from 'globby'
import { NexeCompiler } from '../compiler'

export default async function resource(compiler: NexeCompiler, next: () => Promise<any>) {
  const { cwd, resources } = compiler.options
  if (!resources.length) {
    return next()
  }
  const step = compiler.log.step('Bundling Resources...')
  let fileCount = 0
  let dirCount = 0

  // workaround for https://github.com/sindresorhus/globby/issues/127
  // and https://github.com/mrmlnc/fast-glob#pattern-syntax
  const resourcesWithForwardSlashes = resources.map(r => r.replace(/\\/g, '/'))

  await each(globs(resourcesWithForwardSlashes, { cwd }), async file => {
    if (await isDirectoryAsync(file)) {
      dirCount++
      step.log(`Including directory: ${file}`)
      await compiler.addDirectoryResource(file)
    } else {
      fileCount++
      step.log(`Including file: ${file}`)
      await compiler.addResource(file)
    }
  })
  step.log(`Included ${fileCount} file(s), ${dirCount} directory(s).`)
  return next()
}
