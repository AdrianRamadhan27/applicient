import * as React from "react";

// Shared drag-and-drop state for the two kanban-shaped mocks (the hero's
// Pipeline tab, the "pipeline tracks itself" carousel slide). Native HTML5
// drag/drop, no library — plain useState mapping card id -> column name,
// updated on drop. Purely local/visual, same "sandboxed facade" idea as
// every other landing-page mock: nothing persists, nothing is sent anywhere.
export function useDragColumns<Col extends string>(initial: Record<string, Col>) {
  const [columns, setColumns] = React.useState(initial);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = React.useState<Col | null>(null);

  const dragHandlers = React.useCallback(
    (cardId: string) => ({
      draggable: true,
      onDragStart: () => setDraggingId(cardId),
      onDragEnd: () => {
        setDraggingId(null);
        setDragOverColumn(null);
      },
    }),
    [],
  );

  const dropHandlers = React.useCallback(
    (column: Col) => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setDragOverColumn(column);
      },
      onDragLeave: () => setDragOverColumn((c) => (c === column ? null : c)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (draggingId) setColumns((c) => ({ ...c, [draggingId]: column }));
        setDraggingId(null);
        setDragOverColumn(null);
      },
    }),
    [draggingId],
  );

  return { columns, setColumns, draggingId, dragOverColumn, dragHandlers, dropHandlers };
}
