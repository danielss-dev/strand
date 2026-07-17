import { describe, expect, it } from 'vitest';

import { inferAzdoServerCollectionUrl } from './azdoProfile';

describe('inferAzdoServerCollectionUrl', () => {
  it('derives the collection boundary from an on-prem repository remote', () => {
    expect(inferAzdoServerCollectionUrl(
      'https://azdops.serviceware.net/sw/Platform/Portal/_git/Portal_UI_Router',
    )).toBe('https://azdops.serviceware.net/sw/Platform');
    expect(inferAzdoServerCollectionUrl(
      'https://ado.corp/tfs/DefaultCollection/My%20Project/_git/web.git',
    )).toBe('https://ado.corp/tfs/DefaultCollection');
    expect(inferAzdoServerCollectionUrl(
      'ssh://git@azdops.serviceware.net:22/sw/Platform/Portal/_git/Portal_UI_Router',
    )).toBe('https://azdops.serviceware.net/sw/Platform');
    expect(inferAzdoServerCollectionUrl(
      'git@ado.corp:tfs/DefaultCollection/My%20Project/_git/web.git',
    )).toBe('https://ado.corp/tfs/DefaultCollection');
  });

  it('does not treat cloud or unrelated remotes as Server collections', () => {
    expect(inferAzdoServerCollectionUrl('https://dev.azure.com/acme/Project/_git/web')).toBe('');
    expect(inferAzdoServerCollectionUrl('https://github.com/acme/web.git')).toBe('');
    expect(inferAzdoServerCollectionUrl(null)).toBe('');
  });
});
