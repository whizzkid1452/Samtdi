"use client";

import { Alert, Button, Paper, Skeleton, Stack, Text, VisuallyHidden } from "@mantine/core";
import type { ReactNode } from "react";

export function InlineError({ message, retry, retryLabel = "다시 시도", retrying = false }: {
  message: string;
  retry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
}) {
  return (
    <Alert color="red" role="alert">
      <div className="row spread wrap">
        <span>{message}</span>
        {retry && <Button type="button" variant="default" size="compact-sm" loading={retrying} onClick={retry}>{retryLabel}</Button>}
      </div>
    </Alert>
  );
}

export function LoadingRows({ label }: { label: string }) {
  return (
    <div className="loading-rows" role="status">
      <VisuallyHidden>{label}</VisuallyHidden>
      <Stack gap="xs" aria-hidden="true">
        <Skeleton height={18} width="75%" />
        <Skeleton height={18} width="55%" />
        <Skeleton height={18} width="65%" />
      </Stack>
    </div>
  );
}

export function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <Paper className="empty-state" withBorder p="md">
      <Text size="sm" c="dimmed">{message}</Text>
      {children}
    </Paper>
  );
}
