import { describe, expect, it } from 'vitest';

import {
  createAzdoServerProfile,
  inferAzdoServerCollectionUrl,
  resolveAzdoServerCollectionUrl,
} from './azdoProfile';

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

describe('resolveAzdoServerCollectionUrl', () => {
  it('keeps an explicit collection URL', () => {
    expect(resolveAzdoServerCollectionUrl(' https://explicit/collection ', [
      { name: 'origin', url: 'https://server/tfs/DefaultCollection/Project/_git/Repo' },
    ])).toBe('https://explicit/collection');
  });

  it('infers from the first on-prem remote with origin preferred', () => {
    expect(resolveAzdoServerCollectionUrl('', [
      { name: 'upstream', url: 'https://other/tfs/OtherCollection/Project/_git/Repo' },
      { name: 'origin', url: 'https://server/tfs/DefaultCollection/Project/_git/Repo' },
    ])).toBe('https://server/tfs/DefaultCollection');
  });

  it('skips cloud and unrelated remotes', () => {
    expect(resolveAzdoServerCollectionUrl('', [
      { name: 'origin', url: 'https://github.com/acme/repo' },
      { name: 'server', url: 'git@ado.corp:tfs/DefaultCollection/Project/_git/Repo.git' },
    ])).toBe('https://ado.corp/tfs/DefaultCollection');
  });
});
