import { Libzip } from '@yarnpkg/libzip'
import {
  FakeFS,
  PortablePath,
  ZipFS,
  ZipOpenFS,
  RmdirOptions,
  OpendirOptions,
} from '@yarnpkg/fslib'
import { ZipOpenFSOptions } from '@yarnpkg/fslib/lib/ZipOpenFS'
import {
  WriteFileOptions,
  CreateWriteStreamOptions,
  BasePortableFakeFS,
  Dirent,
  MkdirOptions,
  Dir,
} from '@yarnpkg/fslib/lib/FakeFS'
import { CustomDir } from '@yarnpkg/fslib/lib/algorithms/opendir'
import { FSPath, ppath, npath, Filename } from '@yarnpkg/fslib/lib/path'
// @ts-ignore
import { resolve, toNamespacedPath } from 'path'
import { WriteStream, constants } from 'fs'

export type SnapshotZipFSOptions = {
  baseFs: FakeFS<PortablePath>
  libzip: Libzip | (() => Libzip)
  zipFs: ZipFS
}

import { uniqBy } from 'lodash'
function uniqReaddir(arr: Array<string | Dirent>) {
  return uniqBy(arr, (s: string | Dirent) => (typeof s === 'string' ? s : s.name))
}

export class SnapshotZipFS extends BasePortableFakeFS {
  zipFs: ZipFS
  baseFs: FakeFS<PortablePath>
  constructor(opts: SnapshotZipFSOptions) {
    super()
    this.zipFs = opts.zipFs
    this.baseFs = opts.baseFs
  }
  private readonly fdMap: Map<number, [ZipFS, number]> = new Map()
  private nextFd = 3

  async makeCallPromise<T>(
    p: FSPath<PortablePath>,
    discard: () => Promise<T>,
    accept: (zipFS: ZipFS, zipInfo: { subPath: PortablePath }) => Promise<T>,
    { requireSubpath = true }: { requireSubpath?: boolean } = {}
  ): Promise<T> {
    if (typeof p !== 'string') return await discard()

    const normalizedP = this.resolve(p)

    const zipInfo = this.findZip(normalizedP)
    if (!zipInfo) return await discard()

    if (requireSubpath && zipInfo.subPath === '/') return await discard()

    return await accept(this.zipFs, zipInfo)
  }

  makeCallSync<T>(
    p: FSPath<PortablePath>,
    discard: () => T,
    accept: (zipFS: ZipFS, zipInfo: { subPath: PortablePath; archivePath: string }) => T,
    { requireSubpath = true }: { requireSubpath?: boolean } = {}
  ): T {
    if (typeof p !== 'string') return discard()

    const normalizedP = this.resolve(p)

    const zipInfo = this.findZip(normalizedP)
    if (!zipInfo) return discard()

    if (requireSubpath && zipInfo.subPath === '/') return discard()

    return accept(this.zipFs, { archivePath: '', ...zipInfo })
  }

  async realpathPromise(p: PortablePath) {
    return await this.makeCallPromise(
      p,
      async () => {
        return await this.baseFs.realpathPromise(p)
      },
      async (zipFs, { subPath }) => {
        return await zipFs.realpathPromise(subPath)
      }
    )
  }

  realpathSync(p: PortablePath) {
    return this.makeCallSync(
      p,
      () => {
        return this.baseFs.realpathSync(p)
      },
      (zipFs, { subPath }) => {
        return zipFs.realpathSync(subPath)
      }
    )
  }

  findZip(p: PortablePath) {
    p = this.resolve(p)
    const pathsToTry = Array.from(
      new Set([
        p,
        resolve('/snapshot', p),
        ppath.resolve(
          npath.toPortablePath('/snapshot'),
          npath.toPortablePath(
            npath.relative(npath.fromPortablePath(process.cwd()), npath.fromPortablePath(p))
          )
        ),
        ppath.resolve(
          npath.toPortablePath('/snapshot'),
          npath.toPortablePath(
            npath.relative(
              toNamespacedPath(npath.fromPortablePath(process.cwd())),
              toNamespacedPath(npath.fromPortablePath(p))
            )
          )
        ),
      ])
    )
    for (const path of pathsToTry) {
      const portablePath = npath.toPortablePath(path)
      if (this.zipFs.existsSync(portablePath)) {
        return {
          subPath: portablePath,
        }
      }
    }
  }

  async copyFilePromise(sourceP: PortablePath, destP: PortablePath, flags: number = 0) {
    const fallback = async (
      sourceFs: FakeFS<PortablePath>,
      sourceP: PortablePath,
      destFs: FakeFS<PortablePath>,
      destP: PortablePath
    ) => {
      if ((flags & constants.COPYFILE_FICLONE_FORCE) !== 0)
        throw Object.assign(
          new Error(`EXDEV: cross-device clone not permitted, copyfile '${sourceP}' -> ${destP}'`),
          { code: `EXDEV` }
        )
      if (flags & constants.COPYFILE_EXCL && (await this.existsPromise(sourceP)))
        throw Object.assign(
          new Error(`EEXIST: file already exists, copyfile '${sourceP}' -> '${destP}'`),
          { code: `EEXIST` }
        )

      let content
      try {
        content = await sourceFs.readFilePromise(sourceP)
      } catch (error) {
        throw Object.assign(
          new Error(`EINVAL: invalid argument, copyfile '${sourceP}' -> '${destP}'`),
          { code: `EINVAL` }
        )
      }

      await destFs.writeFilePromise(destP, content)
    }

    return await this.makeCallPromise(
      sourceP,
      async () => {
        return await this.baseFs.copyFilePromise(sourceP, destP, flags)
      },
      async (zipFsS, { subPath: subPathS }) => {
        return await fallback(zipFsS, subPathS, this.baseFs, destP)
      }
    )
  }

  copyFileSync(sourceP: PortablePath, destP: PortablePath, flags: number = 0) {
    const fallback = (
      sourceFs: FakeFS<PortablePath>,
      sourceP: PortablePath,
      destFs: FakeFS<PortablePath>,
      destP: PortablePath
    ) => {
      if ((flags & constants.COPYFILE_FICLONE_FORCE) !== 0)
        throw Object.assign(
          new Error(`EXDEV: cross-device clone not permitted, copyfile '${sourceP}' -> ${destP}'`),
          { code: `EXDEV` }
        )
      if (flags & constants.COPYFILE_EXCL && this.existsSync(sourceP))
        throw Object.assign(
          new Error(`EEXIST: file already exists, copyfile '${sourceP}' -> '${destP}'`),
          { code: `EEXIST` }
        )

      let content
      try {
        content = sourceFs.readFileSync(sourceP)
      } catch (error) {
        throw Object.assign(
          new Error(`EINVAL: invalid argument, copyfile '${sourceP}' -> '${destP}'`),
          { code: `EINVAL` }
        )
      }

      destFs.writeFileSync(destP, content)
    }

    return this.makeCallSync(
      sourceP,
      () => {
        return this.baseFs.copyFileSync(sourceP, destP, flags)
      },
      (zipFsS, { subPath: subPathS }) => {
        return fallback(zipFsS, subPathS, this.baseFs, destP)
      }
    )
  }
  async readdirPromise(p: PortablePath): Promise<Array<Filename>>
  async readdirPromise(
    p: PortablePath,
    opts: { withFileTypes: false } | null
  ): Promise<Array<Filename>>
  async readdirPromise(p: PortablePath, opts: { withFileTypes: true }): Promise<Array<Dirent>>
  async readdirPromise(
    p: PortablePath,
    opts: { withFileTypes: boolean }
  ): Promise<Array<Filename> | Array<Dirent>>
  async readdirPromise(
    p: PortablePath,
    opts?: { withFileTypes?: boolean } | null
  ): Promise<Array<string | Dirent>> {
    const fallback = async () => {
      return await this.baseFs.readdirPromise(p, opts as any)
    }
    return await this.makeCallPromise(
      p,
      fallback,
      async (zipFs, { subPath }) => {
        const fallbackPaths: Array<string | Dirent> = await fallback().catch(() => [])
        return Promise.resolve(
          uniqReaddir(
            (fallbackPaths as any[]).concat(await zipFs.readdirPromise(subPath, opts as any))
          )
        )
      },
      {
        requireSubpath: false,
      }
    )
  }

  readdirSync(p: PortablePath): Array<Filename>
  readdirSync(p: PortablePath, opts: { withFileTypes: false } | null): Array<Filename>
  readdirSync(p: PortablePath, opts: { withFileTypes: true }): Array<Dirent>
  readdirSync(p: PortablePath, opts: { withFileTypes: boolean }): Array<Filename> | Array<Dirent>
  readdirSync(p: PortablePath, opts?: { withFileTypes?: boolean } | null): Array<string | Dirent> {
    const fallback = () => {
      return this.baseFs.readdirSync(p, opts as any)
    }
    return this.makeCallSync(
      p,
      fallback,
      (zipFs, { subPath }) => {
        let fallbackPaths: Array<string | Dirent> = []
        try {
          fallbackPaths = fallback()
        } catch (e) {}
        return (fallbackPaths as any[]).concat(uniqReaddir(zipFs.readdirSync(subPath, opts as any)))
      },
      {
        requireSubpath: false,
      }
    )
  }

  async mkdirPromise(p: PortablePath, opts?: MkdirOptions) {
    return await this.baseFs.mkdirPromise(p, opts)
  }

  mkdirSync(p: PortablePath, opts?: MkdirOptions) {
    return this.baseFs.mkdirSync(p, opts)
  }

  async rmdirPromise(p: PortablePath, opts?: RmdirOptions) {
    return await this.baseFs.rmdirPromise(p, opts)
  }

  rmdirSync(p: PortablePath, opts?: RmdirOptions) {
    return this.baseFs.rmdirSync(p, opts)
  }

  async opendirPromise(p: PortablePath, opts?: OpendirOptions) {
    return Promise.resolve(this.zipFs.opendirSync(p, opts))
  }

  opendirSync(p: PortablePath, opts?: OpendirOptions) {
    const zipInfo = this.findZip(p)
    let zipFsDir: Dir<PortablePath> | null = null
    if (zipInfo) {
      zipFsDir = this.zipFs.opendirSync(zipInfo.subPath)
    }
    let realFsDir: Dir<PortablePath> | null = null
    try {
      realFsDir = this.baseFs.opendirSync(p)
    } catch (e) {
      if (!zipFsDir) throw e
    }
    const seen = new Set()
    const nextDirent = () => {
      const entry = realFsDir?.readSync() || zipFsDir?.readSync()
      if (entry && !seen.has(entry.name)) {
        seen.add(entry.name)
        return entry
      }
      return null
    }

    const onClose = () => {
      zipFsDir?.closeSync()
      realFsDir?.closeSync()
    }

    return new CustomDir(p, nextDirent, { onClose })
  }

  accessPromise = ZipOpenFS.prototype.accessPromise
  accessSync = ZipOpenFS.prototype.accessSync
  appendFilePromise = ZipOpenFS.prototype.appendFilePromise
  appendFileSync = ZipOpenFS.prototype.appendFileSync
  chmodPromise = ZipOpenFS.prototype.chmodPromise
  chmodSync = ZipOpenFS.prototype.chmodSync
  fchmodPromise = ZipOpenFS.prototype.fchmodPromise
  fchmodSync = ZipOpenFS.prototype.fchmodSync
  chownPromise = ZipOpenFS.prototype.chownPromise
  chownSync = ZipOpenFS.prototype.chownSync
  fchownPromise = ZipOpenFS.prototype.fchownPromise
  fchownSync = ZipOpenFS.prototype.fchownSync
  closePromise = ZipOpenFS.prototype.closePromise
  closeSync = ZipOpenFS.prototype.closeSync
  createReadStream = ZipOpenFS.prototype.createReadStream
  createWriteStream = ZipOpenFS.prototype.createWriteStream
  existsPromise = ZipOpenFS.prototype.existsPromise
  existsSync = ZipOpenFS.prototype.existsSync
  fstatPromise = ZipOpenFS.prototype.fstatPromise
  fstatSync = ZipOpenFS.prototype.fstatSync
  getExtractHint = ZipOpenFS.prototype.getExtractHint
  getRealPath = ZipOpenFS.prototype.getRealPath
  linkPromise = ZipOpenFS.prototype.linkPromise
  linkSync = ZipOpenFS.prototype.linkSync
  lstatPromise = ZipOpenFS.prototype.lstatPromise
  lstatSync = ZipOpenFS.prototype.lstatSync
  openPromise = ZipOpenFS.prototype.openPromise
  openSync = ZipOpenFS.prototype.openSync
  readFilePromise = ZipOpenFS.prototype.readFilePromise
  readFileSync = ZipOpenFS.prototype.readFileSync
  readlinkPromise = ZipOpenFS.prototype.readlinkPromise
  readlinkSync = ZipOpenFS.prototype.readlinkSync
  readPromise = ZipOpenFS.prototype.readPromise
  readSync = ZipOpenFS.prototype.readSync
  renamePromise = ZipOpenFS.prototype.renamePromise
  renameSync = ZipOpenFS.prototype.renameSync
  resolve = ZipOpenFS.prototype.resolve
  statPromise = ZipOpenFS.prototype.statPromise
  statSync = ZipOpenFS.prototype.statSync
  symlinkPromise = ZipOpenFS.prototype.symlinkPromise
  symlinkSync = ZipOpenFS.prototype.symlinkSync
  truncatePromise = ZipOpenFS.prototype.truncatePromise
  truncateSync = ZipOpenFS.prototype.truncateSync
  ftruncatePromise = ZipOpenFS.prototype.ftruncatePromise
  ftruncateSync = ZipOpenFS.prototype.ftruncateSync
  unlinkPromise = ZipOpenFS.prototype.unlinkPromise
  unlinkSync = ZipOpenFS.prototype.unlinkSync
  unwatchFile = ZipOpenFS.prototype.unwatchFile
  utimesPromise = ZipOpenFS.prototype.utimesPromise
  utimesSync = ZipOpenFS.prototype.utimesSync
  watch = ZipOpenFS.prototype.watch
  watchFile = ZipOpenFS.prototype.watchFile
  writeFilePromise = ZipOpenFS.prototype.writeFilePromise
  writeFileSync = ZipOpenFS.prototype.writeFileSync
  writePromise = ZipOpenFS.prototype.writePromise
  writeSync = ZipOpenFS.prototype.writeSync

  // @ts-ignore
  remapFd = ZipOpenFS.prototype.remapFd
}