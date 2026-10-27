// The five run views. Each is a standalone component taking (detail, compact?) so the multiviewer
// tiles can reuse them unchanged.

import type { ComponentType } from 'react';
import type { RunView } from '@shared/settings';
import { ActivityView, type RunViewProps } from './ActivityView';
import { FilesView } from './FilesView';
import { OverviewView } from './OverviewView';
import { TimelineView } from './TimelineView';
import { ToolsView } from './ToolsView';

export interface ViewDef {
  id: RunView;
  label: string;
  key: string;
  Component: ComponentType<RunViewProps>;
}

export const VIEWS: ViewDef[] = [
  { id: 'activity', label: 'Activity', key: '1', Component: ActivityView },
  { id: 'overview', label: 'Overview', key: '2', Component: OverviewView },
  { id: 'files', label: 'Files', key: '3', Component: FilesView },
  { id: 'tools', label: 'Tools', key: '4', Component: ToolsView },
  { id: 'timeline', label: 'Timeline', key: '5', Component: TimelineView },
];

export const VIEW_BY_ID: Record<RunView, ViewDef> = Object.fromEntries(VIEWS.map((v) => [v.id, v])) as Record<RunView, ViewDef>;

export type { RunViewProps };
export { ActivityView, FilesView, OverviewView, TimelineView, ToolsView };
