import type { SVGProps } from 'react';

export type IconName =
  | 'check'
  | 'chevron'
  | 'cloud'
  | 'download'
  | 'eye'
  | 'eye-off'
  | 'file'
  | 'files'
  | 'hard-drive'
  | 'lock'
  | 'log-out'
  | 'search'
  | 'settings'
  | 'telegram'
  | 'trash'
  | 'upload'
  | 'user'
  | 'x';

const paths: Record<IconName, string[]> = {
  check: ['M20 6 9 17l-5-5'],
  chevron: ['m9 18 6-6-6-6'],
  cloud: ['M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  eye: ['M2.1 12a10 10 0 0 1 19.8 0 10 10 0 0 1-19.8 0', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  'eye-off': ['m3 3 18 18', 'M10.6 10.6a2 2 0 0 0 2.8 2.8', 'M9.9 4.2A10.6 10.6 0 0 1 22 12a14 14 0 0 1-2.1 3.2', 'M6.6 6.6A13.7 13.7 0 0 0 2 12a10.8 10.8 0 0 0 12.9 7.5'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6'],
  files: ['M15 2H6a2 2 0 0 0-2 2v13', 'M18 7h-7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z'],
  'hard-drive': ['M22 12H2', 'M5.5 7h13l3.5 5v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-5Z', 'M6 16h.01', 'M10 16h.01'],
  lock: ['M6 10V8a6 6 0 0 1 12 0v2', 'M5 10h14v12H5Z', 'M12 14v4'],
  'log-out': ['M10 17l5-5-5-5', 'M15 12H3', 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4'],
  search: ['m21 21-4.3-4.3', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  telegram: ['m22 2-7 20-4-9-9-4Z', 'm22 2-11 11'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 16H6L5 6', 'M10 11v6', 'M14 11v6'],
  upload: ['M12 16V4', 'm7 9 5-5 5 5', 'M5 20h14'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
};

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

export function Icon({ name, size = 20, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {paths[name].map((path, index) => (
        <path
          d={path}
          key={index}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      ))}
    </svg>
  );
}
