import { afterEach, describe, expect, it } from 'vitest';
import { buildCommit } from './build';

const TOUCHED = [
  'BUILD_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_VERSION',
];

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name];
});

describe('buildCommit', () => {
  it('reports the running commit, shortened', () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = '1b46cadb4d930903da8ed7ad7af04dcbd443663c';
    expect(buildCommit()).toBe('1b46cad');
  });

  it('prefers an explicit override to whatever the host injected', () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env['BUILD_SHA'] = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(buildCommit()).toBe('bbbbbbb');
  });

  it('is null when the host said nothing', () => {
    // Null, not "unknown": a placeholder rendered in a footer reads as a commit named
    // unknown, which is worse than saying nothing.
    expect(buildCommit()).toBeNull();
  });

  it('ignores an empty value, which is what an unset templated variable becomes', () => {
    process.env['RAILWAY_GIT_COMMIT_SHA'] = '';
    process.env['GIT_COMMIT_SHA'] = '   ';
    expect(buildCommit()).toBeNull();
  });

  it('ignores a value that is not a commit at all', () => {
    // A host that substitutes a literal placeholder must not have it printed as a SHA.
    process.env['RAILWAY_GIT_COMMIT_SHA'] = '$RAILWAY_GIT_COMMIT_SHA';
    expect(buildCommit()).toBeNull();
  });

  it('lowercases, so the same commit never renders two ways', () => {
    process.env['BUILD_SHA'] = '1B46CADB4D930903';
    expect(buildCommit()).toBe('1b46cad');
  });
});
