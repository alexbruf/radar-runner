import { h, type ComponentChildren } from 'preact';
import './radar-runner-shell';

export interface RadarRunnerProps {
  colorMode?: 'dark' | 'light';
  width?: number;
  height?: number;
  collapsed?: boolean;
  className?: string;
  style?: Record<string, string | number>;
  children?: ComponentChildren;
}

export function RadarRunner({
  colorMode,
  width,
  height,
  collapsed,
  className,
  style,
  children,
}: RadarRunnerProps) {
  return h(
    'radar-runner',
    {
      'color-mode': colorMode,
      width: width?.toString(),
      height: height?.toString(),
      collapsed: collapsed ? '' : undefined,
      class: className,
      style,
    },
    children,
  );
}
