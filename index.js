/**
 * Host half of Usage cost.
 *
 * The feature runs in the browser half; this row exists so the package is an
 * enabled Loader entry. It also asks the client-module registry to re-read this
 * package's browser bundle after an entry restart: the Host otherwise serves the
 * copy it cached at boot, which made "rebuild then refresh the page" silently
 * keep running the old code.
 */
export function apply(ctx) {
  ctx.inject(['clientModules'], (scoped) => {
    const bump = () => {
      try {
        scoped.clientModules.rebuilt('@local/usage-cost')
      } catch (error) {
        // An older build without the hook: the bundle stays on the cached copy.
      }
    }
    bump()
    const timer = setTimeout(bump, 1500)
    ctx.effect(() => () => { clearTimeout(timer) }, 'usage-cost: rebuilt timer')
  })
}
