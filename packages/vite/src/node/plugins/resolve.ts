import fs from 'node:fs'
import path from 'node:path'
import colors from 'picocolors'
import type { PartialResolvedId } from 'rollup'
import { resolve as _resolveExports } from 'resolve.exports'
import type { Plugin } from '../plugin'
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  DEP_VERSION_RE,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  SPECIAL_QUERY_RE
} from '../constants'
import {
  bareImportRE,
  cleanUrl,
  createDebugger,
  ensureVolumeInPath,
  fsPathFromId,
  getPotentialTsSrcPaths,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isFileReadable,
  isObject,
  isPossibleTsOutput,
  isTsRequest,
  nestedResolveFrom,
  normalizePath,
  resolveFrom,
  slash
} from '../utils'
import { optimizedDepInfoFromFile, optimizedDepInfoFromId } from '../optimizer'
import type { DepsOptimizer } from '../optimizer'
import type { SSROptions } from '..'
import type { PackageCache, PackageData } from '../packages'
import { loadPackageData, resolvePackageData } from '../packages'

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
export const browserExternalId = '__vite-browser-external'

const isDebug = process.env.DEBUG
const debug = createDebugger('vite:resolve-details', {
  onlyWhenFocused: true
})

export interface ResolveOptions {
  mainFields?: string[]
  conditions?: string[]
  extensions?: string[]
  dedupe?: string[]
  preserveSymlinks?: boolean
}

export interface InternalResolveOptions extends ResolveOptions {
  root: string
  isBuild: boolean
  isProduction: boolean
  ssrConfig?: SSROptions
  packageCache?: PackageCache
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  asSrc?: boolean
  tryIndex?: boolean
  tryPrefix?: string
  skipPackageJson?: boolean
  preferRelative?: boolean
  preserveSymlinks?: boolean
  isRequire?: boolean
  // #3040
  // when the importer is a ts module,
  // if the specifier requests a non-existent `.js/jsx/mjs/cjs` file,
  // should also try import from `.ts/tsx/mts/cts` source file as fallback.
  isFromTsImporter?: boolean
  tryEsmOnly?: boolean
  // True when resolving during the scan phase to discover dependencies
  scan?: boolean
  // Resolve using esbuild deps optimization
  getDepsOptimizer?: () => DepsOptimizer | undefined
  shouldExternalize?: (id: string) => boolean | undefined
}

export function resolvePlugin(resolveOptions: InternalResolveOptions): Plugin {
  const {
    root,
    isProduction,
    asSrc,
    ssrConfig,
    preferRelative = false
  } = resolveOptions

  const { target: ssrTarget, noExternal: ssrNoExternal } = ssrConfig ?? {}

  return {
    name: 'vite:resolve',

    async resolveId(id, importer, resolveOpts) {
      // We need to delay depsOptimizer until here instead of passing it as an option
      // the resolvePlugin because the optimizer is created on server listen during dev
      const depsOptimizer = resolveOptions.getDepsOptimizer?.()

      const ssr = resolveOpts?.ssr === true

      if (id.startsWith(browserExternalId)) {
        return id
      }

      // fast path for commonjs proxy modules
      if (/\?commonjs/.test(id) || id === 'commonjsHelpers.js') {
        return
      }

      const targetWeb = !ssr || ssrTarget === 'webworker'

      // this is passed by @rollup/plugin-commonjs
      const isRequire: boolean =
        resolveOpts?.custom?.['node-resolve']?.isRequire ?? false

      const options: InternalResolveOptions = {
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan
      }

      if (importer) {
        if (isTsRequest(importer)) {
          options.isFromTsImporter = true
        } else {
          const moduleLang = this.getModuleInfo(importer)?.meta?.vite?.lang
          options.isFromTsImporter = moduleLang && isTsRequest(`.${moduleLang}`)
        }
      }

      let res: string | PartialResolvedId | undefined

      // resolve pre-bundled deps requests, these could be resolved by
      // tryFileResolve or /fs/ resolution but these files may not yet
      // exists if we are in the middle of a deps re-processing
      if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) {
        const optimizedPath = id.startsWith(FS_PREFIX)
          ? fsPathFromId(id)
          : normalizePath(ensureVolumeInPath(path.resolve(root, id.slice(1))))
        return optimizedPath
      }

      // explicit fs paths that starts with /@fs/*
      if (asSrc && id.startsWith(FS_PREFIX)) {
        const fsPath = fsPathFromId(id)
        res = tryFsResolve(fsPath, options)
        isDebug && debug(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        // always return here even if res doesn't exist since /@fs/ is explicit
        // if the file doesn't exist it should be a 404
        return res || fsPath
      }

      // URL
      // /foo -> /fs-root/foo
      if (asSrc && id.startsWith('/')) {
        const fsPath = path.resolve(root, id.slice(1))
        if ((res = tryFsResolve(fsPath, options))) {
          isDebug && debug(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`)
          return res
        }
      }

      // relative
      if (
        id.startsWith('.') ||
        (preferRelative && /^\w/.test(id)) ||
        importer?.endsWith('.html')
      ) {
        const basedir = importer ? path.dirname(importer) : process.cwd()
        const fsPath = path.resolve(basedir, id)
        // handle browser field mapping for relative imports

        const normalizedFsPath = normalizePath(fsPath)

        if (depsOptimizer?.isOptimizedDepFile(normalizedFsPath)) {
          // Optimized files could not yet exist in disk, resolve to the full path
          // Inject the current browserHash version if the path doesn't have one
          if (!normalizedFsPath.match(DEP_VERSION_RE)) {
            const browserHash = optimizedDepInfoFromFile(
              depsOptimizer.metadata({ ssr }),
              normalizedFsPath
            )?.browserHash
            if (browserHash) {
              return injectQuery(normalizedFsPath, `v=${browserHash}`)
            }
          }
          return normalizedFsPath
        }

        const pathFromBasedir = normalizedFsPath.slice(basedir.length)
        if (pathFromBasedir.startsWith('/node_modules/')) {
          // normalize direct imports from node_modules to bare imports, so the
          // hashing logic is shared and we avoid duplicated modules #2503
          const bareImport = pathFromBasedir.slice('/node_modules/'.length)
          if (
            (res = tryNodeResolve(
              bareImport,
              importer,
              options,
              targetWeb,
              depsOptimizer,
              ssr
            )) &&
            res.id.startsWith(normalizedFsPath)
          ) {
            return res
          }
        }

        if (
          targetWeb &&
          (res = tryResolveBrowserMapping(fsPath, importer, options, true))
        ) {
          return res
        }

        if ((res = tryFsResolve(fsPath, options))) {
          isDebug &&
            debug(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`)
          const pkg = importer != null && idToPkgMap.get(importer)
          if (pkg) {
            idToPkgMap.set(res, pkg)
            return {
              id: res,
              moduleSideEffects: pkg.hasSideEffects(res)
            }
          }
          return res
        }
      }

      // absolute fs paths
      if (path.isAbsolute(id) && (res = tryFsResolve(id, options))) {
        isDebug && debug(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        return res
      }

      // external
      if (isExternalUrl(id)) {
        return {
          id,
          external: true
        }
      }

      // data uri: pass through (this only happens during build and will be
      // handled by dedicated plugin)
      if (isDataUrl(id)) {
        return null
      }

      // bare package imports, perform node resolve
      if (bareImportRE.test(id)) {
        const external = options.shouldExternalize?.(id)
        if (
          !external &&
          asSrc &&
          depsOptimizer &&
          !options.scan &&
          (res = await tryOptimizedResolve(depsOptimizer, ssr, id, importer))
        ) {
          return res
        }

        if (
          targetWeb &&
          (res = tryResolveBrowserMapping(
            id,
            importer,
            options,
            false,
            external
          ))
        ) {
          return res
        }

        if (
          (res = tryNodeResolve(
            id,
            importer,
            options,
            targetWeb,
            depsOptimizer,
            ssr,
            external
          ))
        ) {
          return res
        }

        // node built-ins.
        // externalize if building for SSR, otherwise redirect to empty module
        if (isBuiltin(id)) {
          if (ssr) {
            if (ssrNoExternal === true) {
              let message = `Cannot bundle Node.js built-in "${id}"`
              if (importer) {
                message += ` imported from "${path.relative(
                  process.cwd(),
                  importer
                )}"`
              }
              message += `. Consider disabling ssr.noExternal or remove the built-in dependency.`
              this.error(message)
            }

            return {
              id,
              external: true
            }
          } else {
            if (!asSrc) {
              debug(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${colors.white(colors.dim(importer))})`
              )
            }
            return isProduction
              ? browserExternalId
              : `${browserExternalId}:${id}`
          }
        }
      }

      isDebug && debug(`[fallthrough] ${colors.dim(id)}`)
    },

    load(id) {
      if (id.startsWith(browserExternalId)) {
        if (isProduction) {
          return `export default {}`
        } else {
          id = id.slice(browserExternalId.length + 1)
          return `\
export default new Proxy({}, {
  get(_, key) {
    throw new Error(\`Module "${id}" has been externalized for browser compatibility. Cannot access "${id}.\${key}" in client code.\`)
  }
})`
        }
      }
    }
  }
}

function splitFileAndPostfix(path: string) {
  let file = path
  let postfix = ''

  let postfixIndex = path.indexOf('?')
  if (postfixIndex < 0) {
    postfixIndex = path.indexOf('#')
  }
  if (postfixIndex > 0) {
    file = path.slice(0, postfixIndex)
    postfix = path.slice(postfixIndex)
  }
  return { file, postfix }
}

function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true
): string | undefined {
  const { file, postfix } = splitFileAndPostfix(fsPath)

  let res: string | undefined

  // if we fould postfix exist, we should first try resolving file with postfix. details see #4703.
  if (
    postfix &&
    (res = tryResolveFile(
      fsPath,
      '',
      options,
      false,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  if (
    (res = tryResolveFile(
      file,
      postfix,
      options,
      false,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  for (const ext of options.extensions || DEFAULT_EXTENSIONS) {
    if (
      postfix &&
      (res = tryResolveFile(
        fsPath + ext,
        '',
        options,
        false,
        targetWeb,
        options.tryPrefix,
        options.skipPackageJson
      ))
    ) {
      return res
    }

    if (
      (res = tryResolveFile(
        file + ext,
        postfix,
        options,
        false,
        targetWeb,
        options.tryPrefix,
        options.skipPackageJson
      ))
    ) {
      return res
    }
  }

  if (
    postfix &&
    (res = tryResolveFile(
      fsPath,
      '',
      options,
      tryIndex,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }

  if (
    (res = tryResolveFile(
      file,
      postfix,
      options,
      tryIndex,
      targetWeb,
      options.tryPrefix,
      options.skipPackageJson
    ))
  ) {
    return res
  }
}

function tryResolveFile(
  file: string,
  postfix: string,
  options: InternalResolveOptions,
  tryIndex: boolean,
  targetWeb: boolean,
  tryPrefix?: string,
  skipPackageJson?: boolean
): string | undefined {
  // #2051 if we don't have read permission on a directory, existsSync() still
  // works and will result in massively slow subsequent checks (which are
  // unnecessary in the first place)
  if (isFileReadable(file)) {
    if (!fs.statSync(file).isDirectory()) {
      return getRealPath(file, options.preserveSymlinks) + postfix
    } else if (tryIndex) {
      if (!skipPackageJson) {
        const pkgPath = file + '/package.json'
        try {
          // path points to a node package
          const pkg = loadPackageData(pkgPath, options.preserveSymlinks)
          const resolved = resolvePackageEntry(file, pkg, targetWeb, options)
          return resolved
        } catch (e) {
          if (e.code !== 'ENOENT') {
            throw e
          }
        }
      }
      const index = tryFsResolve(file + '/index', options)
      if (index) return index + postfix
    }
  }

  const tryTsExtension = options.isFromTsImporter && isPossibleTsOutput(file)
  if (tryTsExtension) {
    const tsSrcPaths = getPotentialTsSrcPaths(file)
    for (const srcPath of tsSrcPaths) {
      const res = tryResolveFile(
        srcPath,
        postfix,
        options,
        tryIndex,
        targetWeb,
        tryPrefix,
        skipPackageJson
      )
      if (res) return res
    }
    return
  }

  if (tryPrefix) {
    const prefixed = `${path.dirname(file)}/${tryPrefix}${path.basename(file)}`
    return tryResolveFile(prefixed, postfix, options, tryIndex, targetWeb)
  }
}

export const idToPkgMap = new Map<string, PackageData>()

export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptions,
  targetWeb: boolean,
  depsOptimizer?: DepsOptimizer,
  ssr?: boolean,
  externalize?: boolean
): PartialResolvedId | undefined {
  const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options

  ssr ??= false

  // split id by last '>' for nested selected packages, for example:
  // 'foo > bar > baz' => 'foo > bar' & 'baz'
  // 'foo'             => ''          & 'foo'
  const lastArrowIndex = id.lastIndexOf('>')
  const nestedRoot = id.substring(0, lastArrowIndex).trim()
  const nestedPath = id.substring(lastArrowIndex + 1).trim()

  const possiblePkgIds: string[] = []
  for (let prevSlashIndex = -1; ; ) {
    let slashIndex = nestedPath.indexOf('/', prevSlashIndex + 1)
    if (slashIndex < 0) {
      slashIndex = nestedPath.length
    }

    const part = nestedPath.slice(
      prevSlashIndex + 1,
      (prevSlashIndex = slashIndex)
    )
    if (!part) {
      break
    }

    // Assume path parts with an extension are not package roots, except for the
    // first path part (since periods are sadly allowed in package names).
    // At the same time, skip the first path part if it begins with "@"
    // (since "@foo/bar" should be treated as the top-level path).
    if (possiblePkgIds.length ? path.extname(part) : part[0] === '@') {
      continue
    }

    const possiblePkgId = nestedPath.slice(0, slashIndex)
    possiblePkgIds.push(possiblePkgId)
  }

  let basedir: string
  if (dedupe?.some((id) => possiblePkgIds.includes(id))) {
    basedir = root
  } else if (
    importer &&
    path.isAbsolute(importer) &&
    fs.existsSync(cleanUrl(importer))
  ) {
    basedir = path.dirname(importer)
  } else {
    basedir = root
  }

  // nested node module, step-by-step resolve to the basedir of the nestedPath
  if (nestedRoot) {
    basedir = nestedResolveFrom(nestedRoot, basedir, preserveSymlinks)
  }

  let pkg: PackageData | undefined
  const pkgId = possiblePkgIds.reverse().find((pkgId) => {
    pkg = resolvePackageData(pkgId, basedir, preserveSymlinks, packageCache)!
    return pkg
  })!

  if (!pkg) {
    return
  }

  let resolveId = resolvePackageEntry
  let unresolvedId = pkgId
  const isDeepImport = unresolvedId !== nestedPath
  if (isDeepImport) {
    resolveId = resolveDeepImport
    unresolvedId = '.' + nestedPath.slice(pkgId.length)
  }

  let resolved: string | undefined
  try {
    resolved = resolveId(unresolvedId, pkg, targetWeb, options)
  } catch (err) {
    if (!options.tryEsmOnly) {
      throw err
    }
  }
  if (!resolved && options.tryEsmOnly) {
    resolved = resolveId(unresolvedId, pkg, targetWeb, {
      ...options,
      isRequire: false,
      mainFields: DEFAULT_MAIN_FIELDS,
      extensions: DEFAULT_EXTENSIONS
    })
  }
  if (!resolved) {
    return
  }

  const processResult = (resolved: PartialResolvedId) => {
    if (!externalize) {
      return resolved
    }
    const resolvedExt = path.extname(resolved.id)
    let resolvedId = id
    if (isDeepImport) {
      // check ext before externalizing - only externalize
      // extension-less imports and explicit .js imports
      if (resolvedExt && !resolved.id.match(/(.js|.mjs|.cjs)$/)) {
        return
      }
      if (!pkg?.data.exports && path.extname(id) !== resolvedExt) {
        resolvedId += resolvedExt
      }
    }
    return { ...resolved, id: resolvedId, external: true }
  }

  // link id to pkg for browser field mapping check
  idToPkgMap.set(resolved, pkg)
  if ((isBuild && !depsOptimizer) || externalize) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return processResult({
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    })
  }

  if (
    !resolved.includes('node_modules') || // linked
    !depsOptimizer || // resolving before listening to the server
    options.scan // initial esbuild scan phase
  ) {
    return { id: resolved }
  }
  // if we reach here, it's a valid dep import that hasn't been optimized.
  const isJsType = OPTIMIZABLE_ENTRY_RE.test(resolved)

  const exclude = depsOptimizer.options.exclude
  if (
    !isJsType ||
    importer?.includes('node_modules') ||
    exclude?.includes(pkgId) ||
    exclude?.includes(nestedPath) ||
    SPECIAL_QUERY_RE.test(resolved) ||
    (!isBuild && ssr)
  ) {
    // excluded from optimization
    // Inject a version query to npm deps so that the browser
    // can cache it without re-validation, but only do so for known js types.
    // otherwise we may introduce duplicated modules for externalized files
    // from pre-bundled deps.
    if (!isBuild) {
      const versionHash = depsOptimizer.metadata({ ssr }).browserHash
      if (versionHash && isJsType) {
        resolved = injectQuery(resolved, `v=${versionHash}`)
      }
    }
  } else {
    // this is a missing import, queue optimize-deps re-run and
    // get a resolved its optimized info
    const optimizedInfo = depsOptimizer.registerMissingImport(id, resolved, ssr)
    resolved = depsOptimizer.getOptimizedDepId(optimizedInfo)
  }

  if (isBuild) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    }
  } else {
    return { id: resolved! }
  }
}

export async function tryOptimizedResolve(
  depsOptimizer: DepsOptimizer,
  ssr: boolean,
  id: string,
  importer?: string
): Promise<string | undefined> {
  await depsOptimizer.scanProcessing

  const metadata = depsOptimizer.metadata({ ssr })
  if (!metadata) {
    return
  }

  const depInfo = optimizedDepInfoFromId(metadata, id)
  if (depInfo) {
    return depsOptimizer.getOptimizedDepId(depInfo)
  }

  if (!importer) return

  // further check if id is imported by nested dependency
  let resolvedSrc: string | undefined

  for (const optimizedData of metadata.depInfoList) {
    if (!optimizedData.src) continue // Ignore chunks

    const pkgPath = optimizedData.id
    // check for scenarios, e.g.
    //   pkgPath  => "my-lib > foo"
    //   id       => "foo"
    // this narrows the need to do a full resolve
    if (!pkgPath.endsWith(id)) continue

    // lazily initialize resolvedSrc
    if (resolvedSrc == null) {
      try {
        // this may throw errors if unable to resolve, e.g. aliased id
        resolvedSrc = normalizePath(resolveFrom(id, path.dirname(importer)))
      } catch {
        // this is best-effort only so swallow errors
        break
      }
    }

    // match by src to correctly identify if id belongs to nested dependency
    if (optimizedData.src === resolvedSrc) {
      return depsOptimizer.getOptimizedDepId(optimizedData)
    }
  }
}

export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cached = getResolvedCache('.', targetWeb)
  if (cached) {
    return cached
  }
  try {
    let entryPoint: string | undefined | void

    // resolve exports field with highest priority
    // using https://github.com/lukeed/resolve.exports
    if (data.exports) {
      entryPoint = resolveExports(data, '.', options, targetWeb)
    }

    // if exports resolved to .mjs, still resolve other fields.
    // This is because .mjs files can technically import .cjs files which would
    // make them invalid for pure ESM environments - so if other module/browser
    // fields are present, prioritize those instead.
    if (targetWeb && (!entryPoint || entryPoint.endsWith('.mjs'))) {
      // check browser field
      // https://github.com/defunctzombie/package-browser-field-spec
      const browserEntry =
        typeof data.browser === 'string'
          ? data.browser
          : isObject(data.browser) && data.browser['.']
      if (browserEntry) {
        // check if the package also has a "module" field.
        if (
          !options.isRequire &&
          typeof data.module === 'string' &&
          data.module !== browserEntry
        ) {
          // if both are present, we may have a problem: some package points both
          // to ESM, with "module" targeting Node.js, while some packages points
          // "module" to browser ESM and "browser" to UMD.
          // the heuristics here is to actually read the browser entry when
          // possible and check for hints of UMD. If it is UMD, prefer "module"
          // instead; Otherwise, assume it's ESM and use it.
          const resolvedBrowserEntry = tryFsResolve(
            path.join(dir, browserEntry),
            options
          )
          if (resolvedBrowserEntry) {
            const content = fs.readFileSync(resolvedBrowserEntry, 'utf-8')
            if (
              (/typeof exports\s*==/.test(content) &&
                /typeof module\s*==/.test(content)) ||
              /module\.exports\s*=/.test(content)
            ) {
              // likely UMD or CJS(!!! e.g. firebase 7.x), prefer module
              entryPoint = data.module
            }
          }
        } else {
          entryPoint = browserEntry
        }
      }
    }

    if (!entryPoint || entryPoint.endsWith('.mjs')) {
      for (const field of options.mainFields || DEFAULT_MAIN_FIELDS) {
        if (typeof data[field] === 'string') {
          entryPoint = data[field]
          break
        }
      }
    }
    entryPoint ||= data.main

    // try default entry when entry is not define
    // https://nodejs.org/api/modules.html#all-together
    const entryPoints = entryPoint
      ? [entryPoint]
      : ['index.js', 'index.json', 'index.node']

    for (let entry of entryPoints) {
      // make sure we don't get scripts when looking for sass
      if (
        options.mainFields?.[0] === 'sass' &&
        !options.extensions?.includes(path.extname(entry))
      ) {
        entry = ''
        options.skipPackageJson = true
      }

      // resolve object browser field in package.json
      const { browser: browserField } = data
      if (targetWeb && isObject(browserField)) {
        entry = mapWithBrowserField(entry, browserField) || entry
      }

      const entryPointPath = path.join(dir, entry)
      const resolvedEntryPoint = tryFsResolve(entryPointPath, options)
      if (resolvedEntryPoint) {
        isDebug &&
          debug(
            `[package entry] ${colors.cyan(id)} -> ${colors.dim(
              resolvedEntryPoint
            )}`
          )
        setResolvedCache('.', resolvedEntryPoint, targetWeb)
        return resolvedEntryPoint
      }
    }
  } catch (e) {
    packageEntryFailure(id, e.message)
  }
  packageEntryFailure(id)
}

function packageEntryFailure(id: string, details?: string) {
  throw new Error(
    `Failed to resolve entry for package "${id}". ` +
      `The package may have incorrect main/module/exports specified in its package.json` +
      (details ? ': ' + details : '.')
  )
}

function resolveExports(
  pkg: PackageData['data'],
  key: string,
  options: InternalResolveOptions,
  targetWeb: boolean
) {
  const conditions = [options.isProduction ? 'production' : 'development']
  if (!options.isRequire) {
    conditions.push('module')
  }
  if (options.conditions) {
    conditions.push(...options.conditions)
  }

  return _resolveExports(pkg, key, {
    browser: targetWeb,
    require: options.isRequire,
    conditions
  })
}

function resolveDeepImport(
  id: string,
  {
    webResolvedImports,
    setResolvedCache,
    getResolvedCache,
    dir,
    data
  }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cache = getResolvedCache(id, targetWeb)
  if (cache) {
    return cache
  }

  let relativeId: string | undefined | void = id
  const { exports: exportsField, browser: browserField } = data

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      const { file, postfix } = splitFileAndPostfix(relativeId)
      const exportsId = resolveExports(data, file, options, targetWeb)
      if (exportsId !== undefined) {
        relativeId = exportsId + postfix
      } else {
        relativeId = undefined
      }
    } else {
      // not exposed
      relativeId = undefined
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, 'package.json')}.`
      )
    }
  } else if (targetWeb && isObject(browserField)) {
    // resolve without postfix (see #7098)
    const { file, postfix } = splitFileAndPostfix(relativeId)
    const mapped = mapWithBrowserField(file, browserField)
    if (mapped) {
      relativeId = mapped + postfix
    } else if (mapped === false) {
      return (webResolvedImports[id] = browserExternalId)
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField, // try index only if no exports field
      targetWeb
    )
    if (resolved) {
      isDebug &&
        debug(
          `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`
        )
      setResolvedCache(id, resolved, targetWeb)
      return resolved
    }
  }
}

function tryResolveBrowserMapping(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  isFilePath: boolean,
  externalize?: boolean
) {
  let res: string | undefined
  const pkg = importer && idToPkgMap.get(importer)
  if (pkg && isObject(pkg.data.browser)) {
    const mapId = isFilePath ? './' + slash(path.relative(pkg.dir, id)) : id
    const browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser)
    if (browserMappedPath) {
      const fsPath = path.join(pkg.dir, browserMappedPath)
      if ((res = tryFsResolve(fsPath, options))) {
        isDebug &&
          debug(`[browser mapped] ${colors.cyan(id)} -> ${colors.dim(res)}`)
        idToPkgMap.set(res, pkg)
        const result = {
          id: res,
          moduleSideEffects: pkg.hasSideEffects(res)
        }
        return externalize ? { ...result, external: true } : result
      }
    } else if (browserMappedPath === false) {
      return browserExternalId
    }
  }
}

/**
 * given a relative path in pkg dir,
 * return a relative path in pkg dir,
 * mapped with the "map" object
 *
 * - Returning `undefined` means there is no browser mapping for this id
 * - Returning `false` means this id is explicitly externalized for browser
 */
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
): string | false | undefined {
  const normalizedPath = path.posix.normalize(relativePathInPkgDir)

  for (const key in map) {
    const normalizedKey = path.posix.normalize(key)
    if (
      normalizedPath === normalizedKey ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '.js') ||
      equalWithoutSuffix(normalizedPath, normalizedKey, '/index.js')
    ) {
      return map[key]
    }
  }
}

function equalWithoutSuffix(path: string, key: string, suffix: string) {
  return key.endsWith(suffix) && key.slice(0, -suffix.length) === path
}

function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  resolved = ensureVolumeInPath(resolved)
  if (!preserveSymlinks && browserExternalId !== resolved) {
    resolved = fs.realpathSync(resolved)
  }
  return normalizePath(resolved)
}
