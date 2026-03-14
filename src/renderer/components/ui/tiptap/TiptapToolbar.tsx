import { useCurrentEditor, useEditorState } from '@tiptap/react';
import {
  Bold,
  Code,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react';

import { cn } from '@renderer/lib/utils';

import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

import type { ToolbarConfig } from './types';

interface TiptapToolbarProps {
  config?: ToolbarConfig;
}

function ToolbarButton({
  icon,
  active,
  disabled,
  onClick,
  label,
}: {
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'rounded p-1.5 transition-colors',
            'text-[var(--color-text-muted)]',
            'hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]',
            active && 'bg-[var(--color-surface-raised)] text-[var(--color-text)]',
            disabled &&
              'cursor-not-allowed opacity-30 hover:bg-transparent hover:text-[var(--color-text-muted)]'
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />;
}

export function TiptapToolbar({ config }: TiptapToolbarProps) {
  const { editor } = useCurrentEditor();

  // useEditorState — КРИТИЧНО для v3!
  // Без этого active state НЕ обновляется (shouldRerenderOnTransaction: false)
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      return {
        isBold: e.isActive('bold'),
        isItalic: e.isActive('italic'),
        isStrike: e.isActive('strike'),
        isCode: e.isActive('code'),
        isCodeBlock: e.isActive('codeBlock'),
        isBulletList: e.isActive('bulletList'),
        isOrderedList: e.isActive('orderedList'),
        isBlockquote: e.isActive('blockquote'),
        headingLevel:
          ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  if (!editor || !state) return null;

  const c = {
    bold: true,
    italic: true,
    strike: true,
    code: true,
    codeBlock: true,
    heading: { levels: [1, 2, 3] as (1 | 2 | 3)[] },
    bulletList: true,
    orderedList: true,
    blockquote: true,
    horizontalRule: true,
    undoRedo: true,
    ...config,
  };
  const headingLevels = c.heading === false ? [] : (c.heading?.levels ?? [1, 2, 3]);

  const groups: React.ReactNode[][] = [];

  // Group 1: Text formatting
  const textGroup: React.ReactNode[] = [];
  if (c.bold)
    textGroup.push(
      <ToolbarButton
        key="bold"
        icon={<Bold size={14} />}
        active={state.isBold}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold (⌘B)"
      />
    );
  if (c.italic)
    textGroup.push(
      <ToolbarButton
        key="italic"
        icon={<Italic size={14} />}
        active={state.isItalic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic (⌘I)"
      />
    );
  if (c.strike)
    textGroup.push(
      <ToolbarButton
        key="strike"
        icon={<Strikethrough size={14} />}
        active={state.isStrike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        label="Strikethrough (⌘⇧S)"
      />
    );
  if (textGroup.length) groups.push(textGroup);

  // Group 2: Code
  const codeGroup: React.ReactNode[] = [];
  if (c.code)
    codeGroup.push(
      <ToolbarButton
        key="code"
        icon={<Code size={14} />}
        active={state.isCode}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Code (⌘E)"
      />
    );
  if (c.codeBlock)
    codeGroup.push(
      <ToolbarButton
        key="codeBlock"
        icon={<FileCode2 size={14} />}
        active={state.isCodeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        label="Code Block (⌘⌥C)"
      />
    );
  if (codeGroup.length) groups.push(codeGroup);

  // Group 3: Headings
  const headingIcons = { 1: Heading1, 2: Heading2, 3: Heading3 } as const;
  const headingGroup: React.ReactNode[] = headingLevels.map((level) => {
    const Icon = headingIcons[level];
    return (
      <ToolbarButton
        key={`h${level}`}
        icon={<Icon size={14} />}
        active={state.headingLevel === level}
        onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
        label={`Heading ${level}`}
      />
    );
  });
  if (headingGroup.length) groups.push(headingGroup);

  // Group 4: Lists
  const listGroup: React.ReactNode[] = [];
  if (c.bulletList)
    listGroup.push(
      <ToolbarButton
        key="bullet"
        icon={<List size={14} />}
        active={state.isBulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bullet List (⌘⇧8)"
      />
    );
  if (c.orderedList)
    listGroup.push(
      <ToolbarButton
        key="ordered"
        icon={<ListOrdered size={14} />}
        active={state.isOrderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Ordered List (⌘⇧7)"
      />
    );
  if (listGroup.length) groups.push(listGroup);

  // Group 5: Blocks
  const blockGroup: React.ReactNode[] = [];
  if (c.blockquote)
    blockGroup.push(
      <ToolbarButton
        key="quote"
        icon={<Quote size={14} />}
        active={state.isBlockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Blockquote (⌘⇧B)"
      />
    );
  if (c.horizontalRule)
    blockGroup.push(
      <ToolbarButton
        key="hr"
        icon={<Minus size={14} />}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        label="Horizontal Rule"
      />
    );
  if (blockGroup.length) groups.push(blockGroup);

  // Group 6: Undo/Redo
  if (c.undoRedo) {
    groups.push([
      <ToolbarButton
        key="undo"
        icon={<Undo2 size={14} />}
        disabled={!state.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
        label="Undo (⌘Z)"
      />,
      <ToolbarButton
        key="redo"
        icon={<Redo2 size={14} />}
        disabled={!state.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
        label="Redo (⌘⇧Z)"
      />,
    ]);
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--color-border)] px-1.5 py-1">
      {groups.map((group, i) => (
        <div key={i} className="contents">
          {i > 0 && <Divider />}
          {group}
        </div>
      ))}
    </div>
  );
}
