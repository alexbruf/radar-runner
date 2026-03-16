import { createElement, type ReactNode, type CSSProperties } from 'react';
import './radar-runner-shell';

export interface RadarRunnerProps {
  colorMode?: 'dark' | 'light';
  width?: number;
  height?: number;
  collapsed?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
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
  return createElement(
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
