import { type ComponentProps, type JSX, memo, useCallback, useEffect, useRef } from 'react';

import { MessageComposer } from './MessageComposer';

type ThreadAwareMessageComposerProps = ComponentProps<typeof MessageComposer>;

export const ThreadAwareMessageComposer = memo(function ThreadAwareMessageComposer({
  textareaRef,
  ...props
}: ThreadAwareMessageComposerProps): JSX.Element {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof textareaRef === 'function') {
        textareaRef(node);
      } else if (textareaRef) {
        textareaRef.current = node;
      }
    },
    [textareaRef]
  );

  useEffect(() => {
    const focus = (): void => {
      innerRef.current?.focus();
    };
    focus();
    queueMicrotask(focus);
    window.requestAnimationFrame(focus);
  }, []);

  return <MessageComposer {...props} textareaRef={setRef} />;
});
