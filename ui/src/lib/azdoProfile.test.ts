import { describe, expect, it } from 'vitest';

import { createAzdoServerProfile, inferAzdoServerCollectionUrl } from './azdoProfile';

describe('inferAzdoServerCollectionUrl', () => {
  it('keeps an inferred collection URL as a suggestion, not a saved default', () => {
    const suggestion = inferAzdoServerCollectionUrl(
      'https://azdo.example.test/tfs/DefaultCollection/ExampleProject/_git/ExampleRepo',
    );

    expect(suggestion).toBe('https://azdo.example.test/tfs/DefaultCollection');
    expect(createAzdoServerProfile().collection_url).toBe('');
  });

  it('derives the collection boundary from an on-prem repository remote', () => {
    expect(inferAzdoServerCollectionUrl(
      'https://azdo.example.test/tfs/DefaultCollection/ExampleProject/_git/ExampleRepo',
    )).toBe('https://azdo.example.test/tfs/DefaultCollection');
    expect(inferAzdoServerCollectionUrl(
      'https://ado.corp/tfs/DefaultCollection/My%20Project/_git/web.git',
    )).toBe('https://ado.corp/tfs/DefaultCollection');
    expect(inferAzdoServerCollectionUrl(
      'ssh://git@azdo.example.test:22/tfs/DefaultCollection/ExampleProject/_git/ExampleRepo',
    )).toBe('https://azdo.example.test/tfs/DefaultCollection');
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
