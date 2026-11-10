import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Pin, PinOff } from 'lucide-react';

export interface ProjectContextMenuProps {
  isPinned: boolean;
  onTogglePin: () => void;
  children: React.ReactNode;
}

const ProjectContextMenuLazyContent = ({
  isPinned,
  onTogglePin,
}: Pick<ProjectContextMenuProps, 'isPinned' | 'onTogglePin'>): React.JSX.Element => {
  const { t } = useAppTranslation('common');

  return (
    <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? (
          <>
            <PinOff className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.unpin')}</span>
          </>
        ) : (
          <>
            <Pin className="size-3.5 shrink-0" />
            <span>{t('taskContextMenu.pin')}</span>
          </>
        )}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

export const ProjectContextMenu = ({
  isPinned,
  onTogglePin,
  children,
}: ProjectContextMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open ? (
        <ProjectContextMenuLazyContent isPinned={isPinned} onTogglePin={onTogglePin} />
      ) : null}
    </ContextMenu>
  );
};
