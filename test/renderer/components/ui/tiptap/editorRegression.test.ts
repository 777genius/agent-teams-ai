import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Tiptap Markdown editor regression', () => {
  let editor: Editor;

  beforeEach(() => {
    // Match useTiptapEditor: real StarterKit, GFM Markdown and Placeholder.
    editor = new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: [
        StarterKit.configure({}),
        Markdown.configure({ markedOptions: { gfm: true } }),
        Placeholder.configure({ placeholder: 'Write here', showOnlyWhenEditable: true }),
      ],
      content: '',
      contentType: 'markdown',
    });
  });

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('round trips formatting, nested lists, code and links without losing structure', () => {
    const markdown = [
      '# Release notes',
      '',
      '**Bold** and *italic*, ~~removed~~, `inline()`, [docs](https://example.com/docs).',
      '',
      '- Parent',
      '  - Child with **detail**',
      '- Sibling',
      '',
      '1. First',
      '2. Second',
      '',
      '> Quoted *text*',
      '',
      '```ts',
      'const value = "<tag>";',
      '```',
      '',
      'Escaped \\*literal\\* and \\[brackets\\].',
    ].join('\n');

    editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
    const dom = editor.view.dom;
    expect(dom.querySelector('h1')?.textContent).toBe('Release notes');
    expect(dom.querySelector('strong')?.textContent).toBe('Bold');
    expect(dom.querySelector('em')?.textContent).toBe('italic');
    expect(dom.querySelector('s')?.textContent).toBe('removed');
    expect(dom.querySelector('p code')?.textContent).toBe('inline()');
    expect(dom.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
    expect(dom.querySelector('ul li ul li')?.textContent).toBe('Child with detail');
    expect(dom.querySelectorAll('ol > li')).toHaveLength(2);
    expect(dom.querySelector('blockquote em')?.textContent).toBe('text');
    expect(dom.querySelector('pre code')?.textContent).toBe('const value = "<tag>";');
    expect(editor.getText()).toContain('Escaped *literal* and [brackets].');
    const document = editor.getJSON();
    const serialized = editor.getMarkdown();
    expect(serialized).toContain('```ts');
    expect(serialized).toContain('[docs](https://example.com/docs)');

    editor.commands.setContent(serialized, { contentType: 'markdown', emitUpdate: false });
    expect(editor.getJSON()).toEqual(document);
    expect(editor.getMarkdown()).toBe(serialized);
  });

  it('syncs external Markdown silently while subsequent edits still emit updates', () => {
    const onUpdate = vi.fn(({ editor: current }: { editor: Editor }) => current.getMarkdown());
    editor.on('update', onUpdate);
    expect(
      editor.commands.setContent('## External\n\n**Saved** content', {
        contentType: 'markdown',
        emitUpdate: false,
      })
    ).toBe(true);
    expect(editor.view.dom.querySelector('h2')?.textContent).toBe('External');
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('Saved');
    expect(editor.getMarkdown()).toContain('**Saved** content');
    expect(onUpdate).not.toHaveBeenCalled();

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(editor.commands.insertContent('!')).toBe(true);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.results[0].value).toContain('**Saved** content!');
  });

  it('edits a real selection and preserves document and selection through undo and redo', () => {
    editor.commands.setContent('Hello world', { contentType: 'markdown', emitUpdate: false });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6))
    );
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    // Exercise pm/model with nodes returned by the editor's actual schema.
    expect(Fragment.from(editor.state.doc.firstChild!).size).toBe(13);
    expect(editor.chain().toggleBold().insertContent('Hi').run()).toBe(true);
    expect(editor.getMarkdown()).toBe('**Hi** world');
    const edited = editor.getJSON();
    const editedSelection = editor.state.selection.toJSON();
    expect(editor.can().undo()).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe('Hello world');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    expect(editor.can().redo()).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(edited);
    expect(editor.state.selection.toJSON()).toEqual(editedSelection);

    // Wrapping/splitting crosses StarterKit's ProseMirror transform/model imports.
    expect(editor.commands.toggleBulletList()).toBe(true);
    expect(editor.commands.splitListItem('listItem')).toBe(true);
    expect(editor.view.dom.querySelectorAll('ul > li')).toHaveLength(2);
    expect(editor.getMarkdown()).toContain('world');
  });
});
