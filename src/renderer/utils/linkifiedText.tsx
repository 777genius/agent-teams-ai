import { api } from '@renderer/api';

import type { MouseEvent, ReactElement, ReactNode } from 'react';

export interface LinkifiedTextOptions {
  linkClassName?: string;
  stopPropagation?: boolean;
  getLinkLabel?: (url: string) => string;
}

function findNextHttpUrlStart(message: string, fromIndex: number): number {
  const httpIndex = message.indexOf('http://', fromIndex);
  const httpsIndex = message.indexOf('https://', fromIndex);
  if (httpIndex === -1) {
    return httpsIndex;
  }
  if (httpsIndex === -1) {
    return httpIndex;
  }
  return Math.min(httpIndex, httpsIndex);
}

function isUrlTerminatingChar(char: string): boolean {
  return char.trim() === '' || char === '<' || char === '>' || char === ')' || char === ']';
}

function findHttpUrlEnd(message: string, fromIndex: number): number {
  let end = fromIndex;
  while (end < message.length) {
    const char = message[end];
    if (!char || isUrlTerminatingChar(char)) {
      break;
    }
    end += 1;
  }
  return end;
}

function splitUrlTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = '';
  while (/[.,;:!?]$/.test(url)) {
    trailing = `${url[url.length - 1]}${trailing}`;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function isLinkableHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export function renderLinkifiedText(
  message: string,
  options: LinkifiedTextOptions = {}
): ReactElement {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  while (lastIndex < message.length) {
    const start = findNextHttpUrlStart(message, lastIndex);
    if (start === -1) {
      break;
    }
    if (start > lastIndex) {
      nodes.push(message.slice(lastIndex, start));
    }
    const end = findHttpUrlEnd(message, start);
    const rawUrl = message.slice(start, end);
    const { url, trailing } = splitUrlTrailingPunctuation(rawUrl);
    if (!isLinkableHttpUrl(url)) {
      nodes.push(rawUrl);
      lastIndex = end;
      continue;
    }

    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      if (options.stopPropagation === true) {
        event.stopPropagation();
      }
      void api.openExternal(url);
    };

    nodes.push(
      <a key={`${url}:${start}`} href={url} className={options.linkClassName} onClick={handleClick}>
        {options.getLinkLabel?.(url) ?? url}
      </a>
    );
    if (trailing) {
      nodes.push(trailing);
    }
    lastIndex = end;
  }

  if (lastIndex < message.length) {
    nodes.push(message.slice(lastIndex));
  }
  return <span>{nodes.length > 0 ? nodes : message}</span>;
}
