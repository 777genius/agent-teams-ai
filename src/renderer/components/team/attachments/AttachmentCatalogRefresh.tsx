import { Button } from '@renderer/components/ui/button';

export const AttachmentCatalogRefresh = ({
  visible,
  onRefresh,
}: {
  visible: boolean;
  onRefresh: () => void;
}): React.JSX.Element | null => {
  return visible ? (
    <Button type="button" variant="link" size="sm" onClick={onRefresh}>
      Refresh image and video support
    </Button>
  ) : null;
};
