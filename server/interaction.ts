import type { Store } from "./store.ts";
import { recentDialogue, translateCatalog } from "./translator.ts";
import { detect, maskOutput, protect, restore } from "./privacy.ts";

// Only display strings are translated. SDK identifiers, question keys, enum values and tool input stay unchanged.
export async function translateInteraction(
  store: Store,
  sessionId: string,
  data: Record<string, any>,
) {
  const catalog: Record<string, string> = {};
  const questions = Array.isArray(data.input?.questions)
    ? data.input.questions
    : [];
  questions.forEach((q: any, i: number) => {
    if (typeof q.question === "string") catalog[`q${i}`] = q.question;
    if (typeof q.header === "string") catalog[`h${i}`] = q.header;
    q.options?.forEach((o: any, j: number) => {
      catalog[`o${i}_${j}`] = o.label;
      if (o.description) catalog[`d${i}_${j}`] = o.description;
    });
  });
  if (typeof data.request?.message === "string")
    catalog.message = data.request.message;
  if (!Object.keys(catalog).length) return {};
  const bindings = store.bindings(sessionId);
  for (const text of Object.values(catalog))
    for (const finding of detect(text))
      if (!bindings.some((binding) => binding.value === finding.value))
        bindings.push(finding);
  for (const [key, text] of Object.entries(catalog))
    catalog[key] = maskOutput(text, bindings);
  const output = await translateCatalog(
    catalog,
    recentDialogue(store.visibleMessages(sessionId), bindings),
    "",
  );
  return Object.fromEntries(
    Object.entries(output).map(([key, value]) => [
      key,
      restore(value, bindings),
    ]),
  );
}
