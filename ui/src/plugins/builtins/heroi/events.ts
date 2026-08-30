/** Window event used by Heroi's command-palette contribution. */
export const HEROI_NEW_CONVERSATION_EVENT = 'heroi:new-conversation';
export const HEROI_OPEN_REVIEW_EVENT = 'heroi:open-review';
export const HEROI_FILES_DROPPED_EVENT = 'heroi:files-dropped';
export const HEROI_FILE_DRAG_EVENT = 'heroi:file-drag';

export interface HeroiFilesDroppedDetail {
  projectPath: string;
  paths: string[];
}

export interface HeroiFileDragDetail {
  projectPath: string;
  active: boolean;
}
