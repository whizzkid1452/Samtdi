"use client";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, type Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Status, Task } from "./task-editor";

const taskDragKey = Symbol("samtdi-task");

type TaskDragData = Record<string, unknown> & { [taskDragKey]: true; projectId: string; task: Task };

export type TaskMove = { task: Task; status: Status; position?: number; assigneeId?: string };

function isTaskDragData(data: Record<string | symbol, unknown>): data is TaskDragData {
  return data[taskDragKey] === true;
}

export function DraggableTask({ projectId, task, enabled, onMove, children, targetAssignee }: {
  projectId: string; task: Task; enabled: boolean; targetAssignee?: string; onMove: (move: TaskMove) => void; children: ReactNode;
}) {
  const elementRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<Edge | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) return;

    return combine(
      draggable({
        element,
        getInitialData: () => ({ [taskDragKey]: true, projectId, task }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => isTaskDragData(source.data) && source.data.projectId === projectId && source.data.task.id !== task.id,
        getData: ({ input }) => attachClosestEdge({}, { element, input, allowedEdges: ["top", "bottom"] }),
        onDrag: ({ self }) => setEdge(extractClosestEdge(self.data)),
        onDragLeave: () => setEdge(null),
        onDrop: ({ source, self, location }) => {
          setEdge(null);
          if (location.current.dropTargets[0]?.element !== element || !isTaskDragData(source.data)) return;

          onMove({
            task: source.data.task, status: task.status, assigneeId: targetAssignee,
            position: task.position + (extractClosestEdge(self.data) === "bottom" ? 1 : 0),
          });
        },
      }),
    );
  }, [enabled, onMove, projectId, targetAssignee, task]);

  return <article ref={elementRef} className={"task-card" + (dragging ? " task-dragging" : "")} data-drop-edge={edge ?? undefined}>
    {children}
  </article>;
}

export function TaskLane({ projectId, status, label, enabled, onMove, children }: {
  projectId: string; status: Status; label: string; enabled: boolean; onMove: (move: TaskMove) => void; children: ReactNode;
}) {
  const elementRef = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) return;

    return dropTargetForElements({
      element,
      canDrop: ({ source }) => isTaskDragData(source.data) && source.data.projectId === projectId,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source, location }) => {
        setOver(false);
        if (location.current.dropTargets[0]?.element !== element || !isTaskDragData(source.data) || source.data.task.status === status) return;

        onMove({ task: source.data.task, status });
      },
    });
  }, [enabled, onMove, projectId, status]);

  return <section ref={elementRef} className={"lane" + (over ? " lane-drop-active" : "")} aria-label={label} data-status={status}>{children}</section>;
}
