import type { KeyboardEvent } from "react";

export function submitFeedbackShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.nativeEvent.isComposing || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;

  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
