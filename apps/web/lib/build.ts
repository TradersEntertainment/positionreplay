/**
 * Which build is actually running.
 *
 * This exists because of a real half-hour lost to the question "did my push deploy?".
 * A monorepo makes it worse than usual: a change to `packages/renderer` alters what the
 * chart draws while leaving every file under `apps/web` untouched, so the page looks
 * identical whether the new build is live or not, and a host configured to watch only
 * `apps/web` will legitimately skip the deploy. Guessing from the UI is not possible.
 *
 * So the running commit is reported, at `/api/health` and in the page footer. It turns
 * "I think it deployed" into one look.
 *
 * SPEC §15: "No API keys are required for any read path in this spec." A commit SHA is
 * not a secret — it names a revision of a repository someone can already read — but the
 * branch name and the deployment id are not exposed, because neither answers the
 * question and both are noise on a public page.
 */

/**
 * Candidates in order.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA`; the others are what the common alternatives
 * provide, so moving hosts does not silently turn this into "unknown". `BUILD_SHA` is
 * the manual override for a host that provides nothing.
 */
const SHA_VARS = [
  'BUILD_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_VERSION',
] as const;

/** Enough of a SHA to identify a commit, and what `git log --oneline` prints. */
const SHORT_LENGTH = 7;

/**
 * The running commit, short form, or null when the host did not say.
 *
 * Null rather than a placeholder string: "unknown" rendered in a footer looks like a
 * commit named unknown. Absent means the footer says nothing at all, which is honest.
 */
export function buildCommit(): string | null {
  for (const name of SHA_VARS) {
    const value = process.env[name];
    // Trimmed and length-checked: an unset variable in a shell-templated env file
    // arrives as an empty string rather than as absent.
    if (value && /^[0-9a-f]{7,40}$/i.test(value.trim())) {
      return value.trim().slice(0, SHORT_LENGTH).toLowerCase();
    }
  }
  return null;
}
