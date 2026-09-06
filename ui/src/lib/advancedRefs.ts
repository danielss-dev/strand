export interface ObjectSummary { oid: string; kind: string; subject: string }
export interface AdvancedRefs { notes_refs: string[]; notes_tip: string | null; notes: Array<{ object: string; note: string }>; notes_truncated: boolean; replacements: Array<{ original: string; replacement: string }>; replacements_truncated: boolean }
export interface GitNote { target: ObjectSummary; ref_tip: string | null; message: string | null }
export interface ReplaceReview { original: ObjectSummary; replacement: ObjectSummary; previous: string | null }
export type TagEditKind = 'retarget' | 'reannotate';
export interface TagEditReview { name: string; ref_oid: string; current: ObjectSummary; proposed: ObjectSummary; annotation: string | null; signed: boolean; changed_files: number; remotes: string[] }
export interface PublishedTag { remote: string; oid: string | null }
