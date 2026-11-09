import { useCallback, useRef, useState } from "react";

type Draft = { text: string; attachments: string[] };
const empty = (): Draft => ({ text: "", attachments: [] });
const key = (id: string) => "folio-draft:v1:" + id;

function read(id: string): Draft | undefined {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return undefined;
    const data: Partial<Draft> = JSON.parse(raw);
    if (typeof data?.text !== "string" || !Array.isArray(data.attachments))
      return undefined;
    return {
      text: data.text,
      attachments: data.attachments
        .filter((id) => typeof id === "string")
        .slice(0, 12),
    };
  } catch {
    return undefined;
  }
}

function write(id: string, draft: Draft) {
  try {
    if (draft.text || draft.attachments.length)
      localStorage.setItem(key(id), JSON.stringify(draft));
    else localStorage.removeItem(key(id));
    return true;
  } catch {
    return false;
  }
}

export function useDraft() {
  const [draft, setDraft] = useState(empty);
  const scope = useRef("");
  const latest = useRef(draft);
  const memory = useRef(new Map<string, Draft>());
  const attachmentRef = useRef<string[]>([]);
  const display = useCallback((value: Draft) => {
    latest.current = value;
    attachmentRef.current = value.attachments;
    setDraft(value);
  }, []);
  const update = useCallback(
    (value: Draft) => {
      const id = scope.current;
      if (id) {
        if (write(id, value)) memory.current.delete(id);
        else memory.current.set(id, value);
      }
      display(value);
    },
    [display],
  );
  const selectDraft = useCallback(
    (id: string) => {
      scope.current = id;
      const value = memory.current.get(id) ?? read(id) ?? empty();
      display(value);
      return value.attachments;
    },
    [display],
  );
  const setPrompt = useCallback(
    (value: string | ((text: string) => string)) => {
      const text =
        typeof value === "function" ? value(latest.current.text) : value;
      update({ ...latest.current, text });
    },
    [update],
  );
  const setAttached = useCallback(
    (attachments: string[]) => {
      update({ ...latest.current, attachments });
    },
    [update],
  );
  const removeDraft = useCallback(
    (id: string) => {
      memory.current.delete(id);
      write(id, empty());
      if (scope.current === id) display(empty());
    },
    [display],
  );
  const clearSubmitted = useCallback(
    (id: string, text: string, attachments: string[]) => {
      const matches = (value: Draft | undefined) =>
        value?.text.trim() === text.trim() &&
        value.attachments.length === attachments.length &&
        value.attachments.every((item, i) => item === attachments[i]);
      const stored = read(id);
      const local =
        scope.current === id ? latest.current : memory.current.get(id);
      if (matches(stored) || (!stored && matches(local))) write(id, empty());
      if (matches(local)) {
        memory.current.delete(id);
        if (scope.current === id) display(empty());
      }
    },
    [display],
  );
  return {
    prompt: draft.text,
    attached: draft.attachments,
    attachmentRef,
    setPrompt,
    setAttached,
    selectDraft,
    removeDraft,
    clearSubmitted,
  };
}
