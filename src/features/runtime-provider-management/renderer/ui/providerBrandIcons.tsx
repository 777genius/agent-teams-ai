import { useEffect, useState } from 'react';

import type { CSSProperties, JSX } from 'react';

type ProviderBrand = {
  providerId: string;
  displayName: string;
};

interface SvgPath {
  d: string;
  fill?: string;
}

type BrandIconDescriptor =
  | {
      kind: 'svg';
      viewBox: string;
      paths: readonly SvgPath[];
      background: string;
      border: string;
      color: string;
    }
  | {
      kind: 'image';
      src: string;
      background: string;
      border: string;
    }
  | {
      kind: 'letters';
      label: string;
      background: string;
      border: string;
      color: string;
    };

const OPENAI_PATH =
  'M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z';
const GOOGLE_PATH =
  'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z';
const GOOGLE_CLOUD_PATH =
  'M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z';
const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const MISTRAL_PATH =
  'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z';
const MINIMAX_PATH =
  'M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997';
const NVIDIA_PATH =
  'M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z';
const OPENCODE_PATH =
  'M8.40005 17.4H19.2001V21H4.80005V13.8H8.40005V17.4ZM15.6001 10.2V13.8H8.40005V10.2H15.6001ZM19.2001 10.2H15.6001V6.6H4.80005V3H19.2001V10.2Z';
const PERPLEXITY_PATH =
  'M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z';
const VERCEL_PATH = 'm12 1.608 12 20.784H0Z';

// Brand marks are sourced from provider-owned assets where available, or from Simple Icons
// 16.17.0 entries whose source URLs point to the provider's official site/press kit.
// Providers without a verified compact mark use branded initials instead of approximate logos.
const BRAND_ICONS: Record<string, BrandIconDescriptor> = {
  'github-models': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#181717',
    paths: [{ d: GITHUB_PATH }],
  },
  'github-copilot': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#181717',
    paths: [{ d: GITHUB_PATH }],
  },
  'google-cloud': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(66, 133, 244, 0.14)',
    border: 'rgba(66, 133, 244, 0.42)',
    color: '#4285F4',
    paths: [{ d: GOOGLE_CLOUD_PATH }],
  },
  'google-vertex': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(66, 133, 244, 0.14)',
    border: 'rgba(66, 133, 244, 0.42)',
    color: '#4285F4',
    paths: [{ d: GOOGLE_CLOUD_PATH }],
  },
  anthropic: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#CC9B7A',
    border: 'rgba(204, 155, 122, 0.5)',
    color: '#1F1F1E',
    paths: [
      {
        d: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
      },
    ],
  },
  'cloudflare-ai-gateway': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(243, 128, 32, 0.14)',
    border: 'rgba(243, 128, 32, 0.4)',
    color: '#F38020',
    paths: [
      {
        d: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727',
      },
    ],
  },
  'cloudflare-workers-ai': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(243, 128, 32, 0.14)',
    border: 'rgba(243, 128, 32, 0.4)',
    color: '#F38020',
    paths: [
      {
        d: 'm8.213.063 8.879 12.136-8.67 11.739h2.476l8.665-11.735-8.89-12.14Zm4.728 0 9.02 11.992-9.018 11.883h2.496L24 12.656v-1.199L15.434.063ZM7.178 2.02.01 11.398l-.01 1.2 7.203 9.644 1.238-1.676-6.396-8.556 6.361-8.313Z',
      },
    ],
  },
  cloudflare: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(243, 128, 32, 0.14)',
    border: 'rgba(243, 128, 32, 0.4)',
    color: '#F38020',
    paths: [
      {
        d: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727',
      },
    ],
  },
  github: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#181717',
    paths: [{ d: GITHUB_PATH }],
  },
  'gitlab-duo': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(252, 109, 38, 0.14)',
    border: 'rgba(252, 109, 38, 0.42)',
    color: '#FC6D26',
    paths: [
      {
        d: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
      },
    ],
  },
  gitlab: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(252, 109, 38, 0.14)',
    border: 'rgba(252, 109, 38, 0.42)',
    color: '#FC6D26',
    paths: [
      {
        d: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
      },
    ],
  },
  google: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(66, 133, 244, 0.13)',
    border: 'rgba(66, 133, 244, 0.42)',
    color: '#4285F4',
    paths: [{ d: GOOGLE_PATH }],
  },
  'hugging-face': {
    kind: 'letters',
    label: 'HF',
    background: 'rgba(255, 210, 30, 0.18)',
    border: 'rgba(255, 210, 30, 0.42)',
    color: '#FFD21E',
  },
  huggingface: {
    kind: 'letters',
    label: 'HF',
    background: 'rgba(255, 210, 30, 0.18)',
    border: 'rgba(255, 210, 30, 0.42)',
    color: '#FFD21E',
  },
  minimax: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(231, 53, 98, 0.14)',
    border: 'rgba(231, 53, 98, 0.42)',
    color: '#E73562',
    paths: [{ d: MINIMAX_PATH }],
  },
  mistral: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(250, 82, 15, 0.14)',
    border: 'rgba(250, 82, 15, 0.42)',
    color: '#FA520F',
    paths: [{ d: MISTRAL_PATH }],
  },
  'mistral-ai': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(250, 82, 15, 0.14)',
    border: 'rgba(250, 82, 15, 0.42)',
    color: '#FA520F',
    paths: [{ d: MISTRAL_PATH }],
  },
  nvidia: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(118, 185, 0, 0.14)',
    border: 'rgba(118, 185, 0, 0.42)',
    color: '#76B900',
    paths: [{ d: NVIDIA_PATH }],
  },
  opencode: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(148, 163, 184, 0.12)',
    border: 'rgba(148, 163, 184, 0.32)',
    color: '#94A3B8',
    paths: [{ d: OPENCODE_PATH }],
  },
  openai: {
    kind: 'svg',
    viewBox: '0 0 256 260',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#111827',
    paths: [{ d: OPENAI_PATH }],
  },
  openrouter: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(148, 163, 184, 0.13)',
    border: 'rgba(148, 163, 184, 0.38)',
    color: '#94A3B8',
    paths: [
      {
        d: 'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z',
      },
    ],
  },
  perplexity: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(31, 184, 205, 0.14)',
    border: 'rgba(31, 184, 205, 0.42)',
    color: '#1FB8CD',
    paths: [{ d: PERPLEXITY_PATH }],
  },
  'perplexity-agent': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(31, 184, 205, 0.14)',
    border: 'rgba(31, 184, 205, 0.42)',
    color: '#1FB8CD',
    paths: [{ d: PERPLEXITY_PATH }],
  },
  poe: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: 'rgba(93, 92, 222, 0.16)',
    border: 'rgba(93, 92, 222, 0.44)',
    color: '#8f8df2',
    paths: [
      {
        d: 'M24 12.513V8.36c0-.888-.717-1.608-1.603-1.615h-.013c-.498-.009-1.194-.123-1.688-.619-.44-.439-.584-1.172-.622-1.783l-.001.003c-.002-.014-.002-.03-.003-.044l-.001-.03a1.616 1.616 0 0 0-1.607-1.45H5.54a1.59 1.59 0 0 0-.164.008l-.055.009c-.034.004-.068.008-.102.015l-.069.017c-.028.008-.056.013-.083.022-.024.007-.045.015-.07.024-.026.01-.053.018-.08.03-.021.008-.042.02-.063.029-.027.013-.054.024-.08.038l-.059.034c-.025.015-.052.03-.077.047a.967.967 0 0 0-.061.045c-.021.015-.044.03-.065.05a1.21 1.21 0 0 0-.099.09c-.006.005-.013.01-.018.016l-.014.016a1.59 1.59 0 0 0-.094.102c-.017.02-.03.042-.046.062-.016.021-.033.042-.047.063l-.045.074-.037.062-.036.076a.682.682 0 0 0-.058.143l-.027.075-.02.074a.773.773 0 0 0-.018.078c-.006.03-.009.058-.013.088-.003.022-.008.045-.01.069-.003.022-.003.045-.004.068l-.002-.002c-.036.61-.182 1.345-.62 1.784-.496.495-1.191.61-1.69.618h-.012c-.05 0-.1.003-.147.007a1.27 1.27 0 0 0-.072.012c-.029.004-.057.007-.084.012l-.082.02-.072.018c-.026.009-.052.019-.079.027-.024.009-.048.016-.07.026-.024.01-.048.022-.072.034a.767.767 0 0 0-.072.033l-.068.04-.068.041a1.228 1.228 0 0 0-.072.054c-.018.014-.037.026-.053.04a1.627 1.627 0 0 0-.226.227c-.015.016-.027.036-.041.053a1.398 1.398 0 0 0-.054.074c-.016.022-.028.045-.041.067L.19 7.6c-.012.023-.022.047-.033.07l-.034.073c-.01.024-.017.046-.026.07-.01.027-.02.053-.027.08-.007.023-.012.047-.018.071l-.02.082-.012.084c-.003.024-.009.048-.01.072-.007.052-.01.106-.01.16v4.152c0 .888.717 1.609 1.603 1.616h.01c.5.008 1.196.123 1.69.618.43.43.577 1.143.618 1.746v4.13c0 .524.66.754.986.346l2.333-2.92h11.22c.861 0 1.563-.675 1.611-1.524l.001.003c.037-.61.183-1.344.622-1.783.495-.496 1.19-.61 1.689-.619h.012c.044 0 .088-.003.132-.007l.022-.001A1.613 1.613 0 0 0 24 12.513zm-3.85 1.69c-.502.503-1.215.613-1.717.619H5.566c-.501-.006-1.215-.114-1.717-.618-.408-.409-.565-1.117-.618-1.744V8.415c.052-.627.209-1.337.618-1.745.503-.503 1.216-.613 1.717-.619h12.867c.502.006 1.216.115 1.718.619.409.41.564 1.117.618 1.744v4.041c-.052.63-.209 1.339-.618 1.749zM8.424 7.99c-.892 0-1.615.723-1.615 1.615v1.616a1.615 1.615 0 1 0 3.23 0V9.604c0-.892-.723-1.615-1.615-1.615Zm7.154 0c-.893 0-1.616.723-1.616 1.615v1.616a1.615 1.615 0 1 0 3.231 0V9.604c0-.892-.723-1.615-1.615-1.615z',
      },
    ],
  },
  vercel: {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#000000',
    paths: [{ d: VERCEL_PATH }],
  },
  'vercel-ai-gateway': {
    kind: 'svg',
    viewBox: '0 0 24 24',
    background: '#f8fafc',
    border: 'rgba(248, 250, 252, 0.5)',
    color: '#000000',
    paths: [{ d: VERCEL_PATH }],
  },
};

const LETTER_BRANDS: Record<string, BrandIconDescriptor> = {
  'amazon-bedrock': {
    kind: 'letters',
    label: 'AWS',
    background: 'rgba(255, 153, 0, 0.14)',
    border: 'rgba(255, 153, 0, 0.42)',
    color: '#FF9900',
  },
  azure: {
    kind: 'letters',
    label: 'AZ',
    background: 'rgba(0, 120, 212, 0.14)',
    border: 'rgba(0, 120, 212, 0.42)',
    color: '#60a5fa',
  },
  cohere: {
    kind: 'letters',
    label: 'CO',
    background: 'rgba(57, 210, 192, 0.14)',
    border: 'rgba(57, 210, 192, 0.42)',
    color: '#39D2C0',
  },
  deepinfra: {
    kind: 'letters',
    label: 'DI',
    background: 'rgba(125, 92, 255, 0.14)',
    border: 'rgba(125, 92, 255, 0.42)',
    color: '#a78bfa',
  },
  deepseek: {
    kind: 'letters',
    label: 'DS',
    background: 'rgba(77, 132, 255, 0.14)',
    border: 'rgba(77, 132, 255, 0.42)',
    color: '#93c5fd',
  },
  'fireworks-ai': {
    kind: 'letters',
    label: 'FW',
    background: 'rgba(255, 112, 67, 0.14)',
    border: 'rgba(255, 112, 67, 0.42)',
    color: '#fb923c',
  },
  groq: {
    kind: 'letters',
    label: 'G',
    background: 'rgba(255, 93, 56, 0.14)',
    border: 'rgba(255, 93, 56, 0.42)',
    color: '#ff8a65',
  },
  'ollama-cloud': {
    kind: 'letters',
    label: 'OL',
    background: 'rgba(248, 250, 252, 0.12)',
    border: 'rgba(248, 250, 252, 0.36)',
    color: '#f8fafc',
  },
  togetherai: {
    kind: 'letters',
    label: 'TA',
    background: 'rgba(32, 201, 151, 0.14)',
    border: 'rgba(32, 201, 151, 0.42)',
    color: '#5eead4',
  },
  xai: {
    kind: 'letters',
    label: 'xAI',
    background: 'rgba(248, 250, 252, 0.12)',
    border: 'rgba(248, 250, 252, 0.36)',
    color: '#f8fafc',
  },
};

const BRAND_ALIASES: Record<string, string> = {
  'amazon-bedrock': 'amazon-bedrock',
  'aws-bedrock': 'amazon-bedrock',
  'cloudflare-ai-gateway': 'cloudflare-ai-gateway',
  'cloudflare-workers-ai': 'cloudflare-workers-ai',
  'deep-infra': 'deepinfra',
  fireworks: 'fireworks-ai',
  'github-copilot': 'github-copilot',
  'github-models': 'github-models',
  'gitlab-duo': 'gitlab-duo',
  'google-vertex': 'google-vertex',
  'hugging-face': 'huggingface',
  'mistral-ai': 'mistral',
  'ollama-cloud': 'ollama-cloud',
  'opencode-zen': 'opencode',
  'perplexity-agent': 'perplexity',
  'together-ai': 'togetherai',
  'vercel-ai-gateway': 'vercel',
  vertex: 'google-vertex',
};

// Verified against https://models.dev/logos/{provider}.svg by comparing each
// current provider logo to the Models.dev default fallback SVG.
const MODELS_DEV_LOGO_PROVIDER_IDS = new Set([
  '302ai',
  'abacus',
  'aihubmix',
  'alibaba',
  'alibaba-cn',
  'alibaba-coding-plan',
  'alibaba-coding-plan-cn',
  'amazon-bedrock',
  'anthropic',
  'azure',
  'bailing',
  'baseten',
  'berget',
  'cerebras',
  'cloudferro-sherlock',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'cohere',
  'deepinfra',
  'deepseek',
  'digitalocean',
  'dinference',
  'drun',
  'evroc',
  'fastrouter',
  'fireworks-ai',
  'firmware',
  'friendli',
  'github-copilot',
  'github-models',
  'gitlab',
  'google',
  'google-vertex',
  'groq',
  'helicone',
  'hpc-ai',
  'huggingface',
  'iflowcn',
  'inception',
  'inference',
  'io-net',
  'jiekou',
  'kilo',
  'kimi-for-coding',
  'kuae-cloud-coding-plan',
  'llama',
  'llmgateway',
  'lucidquery',
  'meganova',
  'minimax',
  'minimax-cn',
  'mistral',
  'mixlayer',
  'moark',
  'modelscope',
  'moonshotai',
  'moonshotai-cn',
  'nano-gpt',
  'nebius',
  'nova',
  'novita-ai',
  'nvidia',
  'ollama-cloud',
  'openai',
  'opencode',
  'opencode-go',
  'openrouter',
  'ovhcloud',
  'perplexity',
  'perplexity-agent',
  'poe',
  'privatemode-ai',
  'qihang-ai',
  'qiniu-ai',
  'regolo-ai',
  'scaleway',
  'siliconflow',
  'siliconflow-cn',
  'stackit',
  'submodel',
  'tencent-coding-plan',
  'tencent-tokenhub',
  'the-grid-ai',
  'togetherai',
  'v0',
  'venice',
  'vercel',
  'vivgrid',
  'vultr',
  'wafer.ai',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-plan',
  'zenmux',
  'zhipuai',
  'zhipuai-coding-plan',
]);

function normalizeProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(?:^-)|(?:-$)/g, '');
}

function normalizeModelsDevProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(?:^-)|(?:-$)/g, '');
}

function hasLocalGraphicIcon(key: string): boolean {
  const descriptor = BRAND_ICONS[key];
  return Boolean(descriptor && descriptor.kind !== 'letters');
}

function hasLetterIcon(key: string): boolean {
  return Boolean(BRAND_ICONS[key]?.kind === 'letters' || LETTER_BRANDS[key]);
}

function getLocalBrandIconKey(provider: ProviderBrand): string | null {
  const providerId = normalizeProviderKey(provider.providerId);
  const displayName = normalizeProviderKey(provider.displayName);
  const aliasedProviderId = BRAND_ALIASES[providerId] ?? providerId;
  const aliasedDisplayName = BRAND_ALIASES[displayName] ?? displayName;
  const direct = hasLocalGraphicIcon(aliasedProviderId)
    ? aliasedProviderId
    : hasLocalGraphicIcon(aliasedDisplayName)
      ? aliasedDisplayName
      : null;
  if (direct) {
    return direct;
  }

  for (const [needle, iconKey] of Object.entries(BRAND_ALIASES)) {
    if (
      (displayName.includes(needle) || providerId.includes(needle)) &&
      hasLocalGraphicIcon(iconKey)
    ) {
      return iconKey;
    }
  }

  return null;
}

function getModelsDevLogoKey(provider: ProviderBrand): string | null {
  const providerId = normalizeProviderKey(provider.providerId);
  const displayName = normalizeProviderKey(provider.displayName);
  const candidates = [
    normalizeModelsDevProviderId(provider.providerId),
    BRAND_ALIASES[providerId],
    providerId,
    normalizeModelsDevProviderId(provider.displayName),
    BRAND_ALIASES[displayName],
    displayName,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => MODELS_DEV_LOGO_PROVIDER_IDS.has(candidate)) ?? null;
}

function getLetterBrandIconKey(provider: ProviderBrand): string | null {
  const providerId = normalizeProviderKey(provider.providerId);
  const displayName = normalizeProviderKey(provider.displayName);
  const aliasedProviderId = BRAND_ALIASES[providerId] ?? providerId;
  const aliasedDisplayName = BRAND_ALIASES[displayName] ?? displayName;
  const direct = hasLetterIcon(aliasedProviderId)
    ? aliasedProviderId
    : hasLetterIcon(aliasedDisplayName)
      ? aliasedDisplayName
      : null;
  if (direct) {
    return direct;
  }

  for (const [needle, iconKey] of Object.entries(BRAND_ALIASES)) {
    if ((displayName.includes(needle) || providerId.includes(needle)) && hasLetterIcon(iconKey)) {
      return iconKey;
    }
  }

  return null;
}

function fallbackDescriptor(provider: ProviderBrand): BrandIconDescriptor {
  const displayName = provider.displayName.trim();
  return {
    kind: 'letters',
    label: displayName.slice(0, 2).toUpperCase() || provider.providerId.slice(0, 2).toUpperCase(),
    background: 'rgba(148, 163, 184, 0.12)',
    border: 'rgba(148, 163, 184, 0.26)',
    color: '#cbd5e1',
  };
}

function descriptorFor(provider: ProviderBrand): BrandIconDescriptor {
  const localKey = getLocalBrandIconKey(provider);
  if (localKey) {
    return BRAND_ICONS[localKey] ?? fallbackDescriptor(provider);
  }

  const modelsDevKey = getModelsDevLogoKey(provider);
  if (modelsDevKey) {
    return {
      kind: 'image',
      src: `https://models.dev/logos/${encodeURIComponent(modelsDevKey)}.svg`,
      background: 'rgba(148, 163, 184, 0.12)',
      border: 'rgba(148, 163, 184, 0.28)',
    };
  }

  const letterKey = getLetterBrandIconKey(provider);
  if (letterKey) {
    return LETTER_BRANDS[letterKey] ?? fallbackDescriptor(provider);
  }

  return fallbackDescriptor(provider);
}

function shellStyle(descriptor: BrandIconDescriptor): CSSProperties {
  const style: CSSProperties & Record<string, string | undefined> = {};

  style['--runtime-provider-brand-fallback-background'] = descriptor.background;
  style['--runtime-provider-brand-fallback-border'] = descriptor.border;
  if (descriptor.kind !== 'image') {
    style['--runtime-provider-brand-fallback-color'] = descriptor.color;
  }

  return style;
}

export function ProviderBrandIcon({ provider }: { readonly provider: ProviderBrand }): JSX.Element {
  const descriptor = descriptorFor(provider);
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = descriptor.kind === 'image' ? descriptor.src : null;

  useEffect(() => {
    setImageFailed(false);
  }, [imageSrc]);

  const renderedDescriptor =
    descriptor.kind === 'image' && imageFailed ? fallbackDescriptor(provider) : descriptor;

  return (
    <span
      data-testid={`runtime-provider-logo-${provider.providerId}`}
      aria-hidden="true"
      className="runtime-provider-brand-icon inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border"
      style={shellStyle(renderedDescriptor)}
    >
      {renderedDescriptor.kind === 'image' ? (
        <img
          src={renderedDescriptor.src}
          alt=""
          className="size-5 object-contain"
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      ) : null}
      {renderedDescriptor.kind === 'svg' ? (
        <svg viewBox={renderedDescriptor.viewBox} className="h-[18px] w-[18px]" focusable="false">
          {renderedDescriptor.paths.map((path) => (
            <path key={path.d} d={path.d} fill={path.fill ?? 'currentColor'} />
          ))}
        </svg>
      ) : null}
      {renderedDescriptor.kind === 'letters' ? (
        <span className="text-[10px] font-semibold leading-none">{renderedDescriptor.label}</span>
      ) : null}
    </span>
  );
}
