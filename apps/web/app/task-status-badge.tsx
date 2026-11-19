import { Badge } from "@mantine/core";
import { statusLabel, type Status } from "./task-editor";

const statusColors: Record<Status, string> = {
  todo: "gray",
  progress: "samtdi",
  review: "violet",
  done: "teal",
};

export function TaskStatusBadge({ status }: { status: Status }) {
  return <Badge color={statusColors[status]} variant="light" tt="none">{statusLabel(status)}</Badge>;
}
