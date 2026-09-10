/** Native identity captured before refreshing the patches for Stage reviewed. */
export interface ReviewedStageState {
  workdir: string;
  git_dir: string;
  common_dir: string;
  head_ref: string | null;
  head_oid: string | null;
  index_hash: string | null;
}
