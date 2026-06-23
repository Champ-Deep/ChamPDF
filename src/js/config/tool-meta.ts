/**
 * Tool metadata derived from the registry (src/js/config/tools.ts) for the
 * search-first homepage + command palette:
 *  - flatten categories → a single tool list
 *  - assign a Browse group (adds "Sign & secure" and "Convert" on top of the
 *    documents/images/video pillars)
 *  - assign a privacy class (On our servers / External AI / External GPU)
 *  - mark a small set of popular tools
 */

import { categories, type Tool, type Pillar } from './tools.js';

export type BrowseGroup = 'documents' | 'images' | 'video' | 'sign' | 'convert';
export type Privacy = 'local' | 'ai' | 'gpu';

export interface MetaTool extends Tool {
  group: BrowseGroup;
  privacy: Privacy;
  popular: boolean;
  category: string;
}

export const BROWSE_GROUPS: { id: 'all' | BrowseGroup; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'documents', label: 'Documents' },
  { id: 'images', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'sign', label: 'Sign & secure' },
  { id: 'convert', label: 'Convert' },
];

export const PILLAR_LABEL: Record<BrowseGroup, string> = {
  documents: 'Documents',
  images: 'Images',
  video: 'Video',
  sign: 'Sign & secure',
  convert: 'Convert',
};

/** Privacy chip presentation (Phosphor icon + token colors). */
export const PRIVACY_META: Record<
  Privacy,
  { label: string; icon: string; fg: string; bg: string; bd: string }
> = {
  local: {
    label: 'On our servers',
    icon: 'ph-hard-drives',
    fg: 'var(--green)',
    bg: 'var(--green-bg)',
    bd: 'var(--green-bd)',
  },
  ai: {
    label: 'External AI',
    icon: 'ph-sparkle',
    fg: 'var(--amber)',
    bg: 'var(--amber-bg)',
    bd: 'var(--amber-bd)',
  },
  gpu: {
    label: 'External GPU',
    icon: 'ph-cpu',
    fg: 'var(--amber)',
    bg: 'var(--amber-bg)',
    bd: 'var(--amber-bd)',
  },
};

const POPULAR_FILES = [
  'edit-banana.html',
  'video-rebrander.html',
  'remove-image-watermark.html',
  'remove-pdf-watermark.html',
  'digital-sign-pdf.html',
  'merge-pdf.html',
  'compress-pdf.html',
  'ocr-pdf.html',
];

function fileOf(href: string): string {
  return href.split('/').pop() || href;
}

function deriveGroup(tool: Tool, categoryName: string): BrowseGroup {
  const file = fileOf(tool.href).toLowerCase();
  const name = tool.name.toLowerCase();
  // Sign & secure: signing, redaction, encryption/protection.
  if (
    categoryName === 'Security & Privacy' ||
    /\b(sign|redact|encrypt|decrypt|password|protect|unlock|certif|signature)\b/.test(
      name
    ) ||
    /(sign|redact|encrypt|decrypt|protect|unlock|signature)/.test(file)
  ) {
    return 'sign';
  }
  // Convert: any converter (category or filename pattern).
  if (/convert/i.test(categoryName) || /(-to-|to-pdf|pdf-to)/.test(file)) {
    return 'convert';
  }
  return tool.pillar as Pillar;
}

function derivePrivacy(tool: Tool): Privacy {
  const file = fileOf(tool.href).toLowerCase();
  const name = tool.name.toLowerCase();
  if (
    file.includes('edit-banana') ||
    name.includes('ai image editor') ||
    name.includes('analyze')
  ) {
    return 'ai';
  }
  if (
    file.includes('video-rebrander') ||
    file.includes('video-background-remover') ||
    name.includes('video logo remover') ||
    name.includes('video background')
  ) {
    return 'gpu';
  }
  return 'local';
}

function build(): MetaTool[] {
  const seen = new Set<string>();
  const out: MetaTool[] = [];
  for (const cat of categories) {
    for (const tool of cat.tools) {
      if (seen.has(tool.href)) continue;
      seen.add(tool.href);
      const file = fileOf(tool.href);
      out.push({
        ...tool,
        category: cat.name,
        group: deriveGroup(tool, cat.name),
        privacy: derivePrivacy(tool),
        popular: POPULAR_FILES.includes(file),
      });
    }
  }
  return out;
}

export const allTools: MetaTool[] = build();
