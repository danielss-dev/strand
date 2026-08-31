import type { ReactNode } from 'react';

import { MessageMarkdown } from './MessageMarkdown';
import { TurnFileChanges, TurnToolCalls } from './TurnPanels';
import type { HeroiActivityLike } from './turnArtifacts';

/**
 * Chat-first assistant turn chrome. Order is intentional (DAN-61 follow-up):
 * tool calls first, then the markdown reply, then files this turn.
 */
export function AssistantTurnBody({
  messageId,
  text,
  activities,
  projectPath,
  toolsExpanded,
  onToggleGroup,
  expandedActivities,
  onToggleActivity,
  onOpenPath,
}: {
  messageId: string;
  text: string;
  activities: readonly HeroiActivityLike[];
  projectPath: string;
  toolsExpanded: boolean;
  onToggleGroup: () => void;
  expandedActivities: ReadonlySet<string>;
  onToggleActivity: (activityId: string) => void;
  onOpenPath: (path: string) => void;
}): ReactNode {
  return (
    <>
      {activities.length > 0 && (
        <TurnToolCalls
          messageId={messageId}
          activities={activities}
          expanded={toolsExpanded}
          onToggleGroup={onToggleGroup}
          expandedActivities={expandedActivities}
          onToggleActivity={onToggleActivity}
        />
      )}
      {text ? <MessageMarkdown text={text} /> : null}
      {activities.length > 0 && (
        <TurnFileChanges
          activities={activities}
          projectPath={projectPath}
          onOpenPath={onOpenPath}
        />
      )}
    </>
  );
}
