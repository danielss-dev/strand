export type DistributionChannel = 'direct' | 'msix';

export function distributionChannel(value: string | undefined): DistributionChannel {
  return value === 'msix' ? 'msix' : 'direct';
}

export const DISTRIBUTION_CHANNEL = distributionChannel(
  import.meta.env.VITE_DISTRIBUTION,
);

export const UPDATES_MANAGED_BY_STORE = DISTRIBUTION_CHANNEL === 'msix';
