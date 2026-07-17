import type { AzdoServerProfile } from './types';

export function createAzdoServerProfile(): AzdoServerProfile {
  return {
    id: crypto.randomUUID(),
    name: '',
    collection_url: '',
    auth_mode: 'pat',
    remote_prefixes: [],
    ca_certificate: null,
  };
}

export function inferAzdoServerCollectionUrl(remote: string | null): string {
  if (!remote) return '';
  try {
    const url = new URL(remote.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return '';
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return '';

    const segments = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git');
    if (gitIndex < 2 || gitIndex + 1 >= segments.length) return '';

    const collectionPath = segments.slice(0, gitIndex - 1).join('/');
    const webHost = url.protocol === 'https:' ? url.host : url.hostname;
    return `https://${webHost}/${collectionPath}`;
  } catch {
    const scp = remote.trim().match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!scp) return '';
    const segments = scp[2].replace(/\.git\/?$/, '').split('/').filter(Boolean);
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git');
    if (gitIndex < 2 || gitIndex + 1 >= segments.length) return '';
    return `https://${scp[1].toLowerCase()}/${segments.slice(0, gitIndex - 1).join('/')}`;
  }
}
