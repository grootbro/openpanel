'use client';

import { useEffect, useState } from 'react';
import {
  type EmbedViewport,
  isInIframe,
  viewportFromIframeRect,
} from '@/utils/embed-viewport';

const SOURCE = 'openpanel-embed';

type ViewportMessage = {
  source: typeof SOURCE;
  type: 'viewport';
  visibleTop: number;
  visibleHeight: number;
};

function isViewportMessage(data: unknown): data is ViewportMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const msg = data as Record<string, unknown>;
  return (
    msg.source === SOURCE &&
    msg.type === 'viewport' &&
    typeof msg.visibleTop === 'number' &&
    typeof msg.visibleHeight === 'number'
  );
}

/**
 * While framed by openpanel-embed.js, keep the visible slice in sync so
 * overlays can pin to what the user actually sees (not mid-document).
 */
export function useEmbedViewport(): EmbedViewport | null {
  const [viewport, setViewport] = useState<EmbedViewport | null>(null);

  useEffect(() => {
    if (!isInIframe()) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (!isViewportMessage(event.data)) {
        return;
      }
      setViewport({
        visibleTop: event.data.visibleTop,
        visibleHeight: event.data.visibleHeight,
      });
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ source: SOURCE, type: 'request-viewport' }, '*');

    const interval = window.setInterval(() => {
      window.parent.postMessage(
        { source: SOURCE, type: 'request-viewport' },
        '*',
      );
    }, 250);

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(interval);
    };
  }, []);

  return viewport;
}

/** Report document height to the parent embed host. */
export function useReportEmbedHeight(enabled = true) {
  useEffect(() => {
    if (!enabled || !isInIframe()) {
      return;
    }

    const publish = () => {
      const height = Math.ceil(
        Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ),
      );
      window.parent.postMessage(
        { source: SOURCE, type: 'resize', height },
        '*',
      );
    };

    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(document.documentElement);
    if (document.body) {
      ro.observe(document.body);
    }
    window.addEventListener('load', publish);

    return () => {
      ro.disconnect();
      window.removeEventListener('load', publish);
    };
  }, [enabled]);
}

export { isInIframe, viewportFromIframeRect };
