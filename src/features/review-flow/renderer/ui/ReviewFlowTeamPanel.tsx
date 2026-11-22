import { useTeamReviewFlow } from '../state/useReviewFlow';

import { ReviewFlowDefaultsErrorBanner } from './ReviewFlowDefaultsErrorBanner';
import { ReviewFlowLoadGate } from './ReviewFlowLoadGate';
import { ReviewFlowPolicyEditor } from './ReviewFlowPolicyEditor';

interface ReviewFlowTeamPanelProps {
  teamName: string;
  testIdPrefix: string;
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * The review-flow editor of the team a board belongs to, wired to the shared data. Hosts only
 * provide the frame. A project copy's board edits its team's one setting.
 */
export const ReviewFlowTeamPanel = ({
  teamName,
  testIdPrefix,
  onSaved,
  onCancel,
}: Readonly<ReviewFlowTeamPanelProps>): React.JSX.Element => {
  const flow = useTeamReviewFlow(teamName);
  return (
    <ReviewFlowLoadGate status={flow.status} error={flow.error} onRetry={() => void flow.reload()}>
      <div className="space-y-3">
        {flow.defaultsError ? <ReviewFlowDefaultsErrorBanner message={flow.defaultsError} /> : null}
        <ReviewFlowPolicyEditor
          scope={{ kind: 'team', teamName: flow.teamName }}
          policy={flow.policy}
          defaults={flow.defaults}
          repair={flow.needsRepair}
          projects={flow.projects}
          onSave={flow.save}
          onSaved={onSaved}
          onCancel={onCancel}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </ReviewFlowLoadGate>
  );
};
